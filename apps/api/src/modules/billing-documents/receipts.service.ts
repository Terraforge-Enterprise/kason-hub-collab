// apps/api/src/modules/billing-documents/receipts.service.ts
//
// P2 R8: issue an immutable RCPT BillingDocument for a recorded payment.
// Reuses issueDocumentTx (docType:"receipt", seriesCode:"RCPT"). Counterparty
// and per-charge lines are derived from the PAID invoice's documented lines
// (one invoice per receipt → one counterparty), so each receipt line carries a
// real chargeId + a NON-NULL categoryId (BillingDocumentLine.categoryId is NOT
// NULL in P2). Idempotency key "receipt:"+paymentId dedupes via issueDocumentTx's
// (organizationId, idempotencyKey) guard. paymentId is stamped on the created row.
import type { Prisma } from "@kason/db";
import { issueDocumentTx } from "./issue.service";
import { chargeSetDigest } from "./graduation.service";

export type IssueReceiptParams = {
  organizationId: string;
  paymentId: string;
  partyId: string;
  settledChargeIds: string[];
  actorUserId: string;
};

export async function issueReceiptDocumentTx(
  tx: Prisma.TransactionClient,
  params: IssueReceiptParams,
): Promise<{ id: string; documentNumber: string } | { skipped: "no_documented_charges" }> {
  if (params.settledChargeIds.length === 0) return { skipped: "no_documented_charges" };

  // Resolve the paid invoice's documented lines for the settled charges. Only
  // invoice/debit_note documents carry the receivable that a receipt acknowledges;
  // CN/RN are excluded. One invoice per receipt → a single counterpartyType.
  const docLines = await tx.billingDocumentLine.findMany({
    where: { chargeId: { in: params.settledChargeIds } },
    select: {
      chargeId: true,
      categoryId: true,
      description: true,
      amount: true,
      sstRate: true,
      isTax: true,
      document: {
        select: {
          docType: true,
          counterpartyType: true,
          apartmentId: true,
          propertyId: true,
          tenancyId: true,
          billingMonth: true,
        },
      },
    },
  });
  // P4 (R12a) widened BillingDocumentLine.chargeId/categoryId to nullable for
  // overpayment-CN lines — but this query is scoped to
  // `chargeId: { in: settledChargeIds }` (real charge UUIDs), which structurally
  // can never match a null chargeId. Narrow the type defensively (never drops a
  // real row) rather than assert, since the invariant is enforced by the WHERE
  // clause, not by this code.
  const invoiceLines = docLines.filter(
    (l): l is typeof l & { chargeId: string; categoryId: string } =>
      l.chargeId !== null &&
      l.categoryId !== null &&
      (l.document.docType === "invoice" || l.document.docType === "debit_note"),
  );
  if (invoiceLines.length === 0) return { skipped: "no_documented_charges" };

  // Dedupe to one line per settled charge (a charge appears once per invoice).
  const byCharge = new Map<string, (typeof invoiceLines)[number]>();
  for (const l of invoiceLines) if (!byCharge.has(l.chargeId)) byCharge.set(l.chargeId, l);
  const lines = [...byCharge.values()];

  const first = lines[0]!;
  const counterpartyType = first.document.counterpartyType as "tenant" | "owner";

  const created = await issueDocumentTx(tx, {
    organizationId: params.organizationId,
    docType: "receipt",
    seriesCode: "RCPT",
    counterpartyType,
    partyId: params.partyId,
    tenancyId: first.document.tenancyId ?? undefined,
    propertyId: first.document.propertyId ?? undefined,
    apartmentId: first.document.apartmentId ?? undefined,
    billingMonth: first.document.billingMonth
      ? first.document.billingMonth.toISOString().slice(0, 10)
      : undefined,
    // Charge-set digest for the same reason graduation carries one: a payment allocated
    // INCREMENTALLY settles a second charge later, and a payment-only key returned the
    // first receipt and dropped the new line — money acknowledged nowhere. A replay with
    // the same charges recomputes the same digest and still dedupes.
    idempotencyKey: `receipt:${params.paymentId}:${chargeSetDigest(lines.map((l) => l.chargeId))}`,
    lines: lines.map((l) => ({
      chargeId: l.chargeId,
      categoryId: l.categoryId,
      description: l.description,
      amount: l.amount.toString(),
      sstRate: l.sstRate.toString(),
      // MUST be carried. Without it the `-SST` sibling counts into `subtotal` while the
      // BASE line's own sstRate contributes that same tax again, so the receipt claims
      // more cash than the tenant paid: an RM108 settlement receipted as RM116.
      isTax: l.isTax,
    })),
    actorUserId: params.actorUserId,
  });

  // Stamp the payment link. On an idempotent replay issueDocumentTx returned the
  // EXISTING row (already carrying this paymentId) — the updateMany is a harmless
  // no-op re-write of the same value, guarded org-scoped.
  await tx.billingDocument.updateMany({
    where: { id: created.id, organizationId: params.organizationId },
    data: { paymentId: params.paymentId },
  });

  return created;
}
