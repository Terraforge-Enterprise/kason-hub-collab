// apps/api/src/modules/billing-documents/graduation.service.ts
//
// Spec R3 — GRADUATION. A proforma is a request for payment; when money actually
// arrives, the lines it paid for become a real invoice.
//
// Must run BEFORE issueReceiptDocumentTx. That function only recognises lines on an
// `invoice`/`debit_note` (receipts.service.ts), so with no graduated invoice yet it
// returns `skipped: "no_documented_charges"` and no receipt is ever created.
//
// ── Two rules keep this from fabricating tax documents ───────────────────────
//
// 1. ONLY FULLY-SETTLED CHARGES GRADUATE. A partial allocation is permitted (only
//    OVER-allocation raises ALLOC_EXCEEDS_OUTSTANDING), so a RM100 charge can be paid
//    RM40 then RM60. Graduating on "this payment touched the charge" minted a full
//    RM100 invoice for each — RM100 billed, RM200 of real LHDN-reportable invoices.
//    Waiting for the charge to be fully settled means the invoice always states the
//    amount actually billed and received, with no proration of the line or its SST
//    sibling. A half-paid line is not a paid line.
//
// 2. A CHARGE ALREADY ON A GRADUATED INVOICE NEVER GRADUATES AGAIN. The per-payment
//    idempotency key alone cannot see a reverse-allocation-then-repay cycle, which
//    settles the same charge under a NEW paymentId. Mirrors issue.service.ts's
//    "already documented (any docType) → skip" guard.
//
// A payment may settle charges sitting on DIFFERENT proformas (nothing scopes an
// allocation array to one month or unit), so lines are grouped by their source proforma
// and one invoice is minted per group. Taking a single arbitrary proforma dropped the
// rest permanently — the per-payment key meant they could never graduate later.
import { createHash } from "node:crypto";
import type { Prisma } from "@kason/db";
import { issueDocumentTx } from "./issue.service";

/**
 * A stable short digest of the charges a document covers.
 *
 * Both graduation and receipt keys were `…:<paymentId>`, which is wrong whenever ONE
 * payment is allocated INCREMENTALLY — recordAndAllocate charge A, then allocate the same
 * payment to charge B. The second call recomputed the same key, issueDocumentTx returned
 * the EXISTING document, and B's lines were discarded: money received, charge settled, no
 * invoice and no receipt covering it anywhere.
 *
 * Including the charge set makes a genuine replay (identical charges) still dedupe, while
 * a real increment gets its own document. Sorted so allocation order cannot change the key.
 */
export function chargeSetDigest(chargeIds: readonly string[]): string {
  return createHash("sha1").update([...chargeIds].sort().join(",")).digest("hex").slice(0, 16);
}

export type GraduateParams = {
  organizationId: string;
  paymentId: string;
  partyId: string;
  /** Charges this payment settled IN FULL. Never the merely-allocated set — see rule 1. */
  paidChargeIds: string[];
  actorUserId: string;
};

export async function graduateProformaForPaymentTx(
  tx: Prisma.TransactionClient,
  params: GraduateParams,
): Promise<{ graduated: { id: string; documentNumber: string }[] }> {
  if (params.paidChargeIds.length === 0) return { graduated: [] };

  // Rule 2: drop any charge that already sits on a graduated invoice.
  const already = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: params.paidChargeIds },
      document: { organizationId: params.organizationId, proformaDocumentId: { not: null } },
    },
    select: { chargeId: true },
  });
  const alreadyGraduated = new Set(already.map((l) => l.chargeId).filter((x): x is string => x !== null));
  const eligible = params.paidChargeIds.filter((id) => !alreadyGraduated.has(id));
  if (eligible.length === 0) return { graduated: [] };

  const lines = await tx.billingDocumentLine.findMany({
    where: {
      chargeId: { in: eligible },
      document: {
        organizationId: params.organizationId,
        docType: "proforma",
        documentStatus: "ISSUED",
      },
    },
    select: {
      chargeId: true,
      categoryId: true,
      description: true,
      amount: true,
      sstRate: true,
      isTax: true,
      documentId: true,
      document: {
        select: { tenancyId: true, propertyId: true, apartmentId: true, listingId: true, billingMonth: true },
      },
    },
    // Deterministic grouping order — the previous code took usable[0] from an unordered
    // findMany, so which proforma "won" was arbitrary.
    orderBy: [{ documentId: "asc" }, { id: "asc" }],
  });

  const usable = lines.filter(
    (l): l is typeof l & { chargeId: string; categoryId: string } =>
      l.chargeId !== null && l.categoryId !== null,
  );
  // No proforma behind these charges — a pre-flag IVTEN charge, or an owner-side one.
  // Fall through to today's behaviour: the receipt hook finds the existing invoice.
  if (usable.length === 0) return { graduated: [] };

  const byProforma = new Map<string, typeof usable>();
  for (const l of usable) byProforma.set(l.documentId, [...(byProforma.get(l.documentId) ?? []), l]);

  const graduated: { id: string; documentNumber: string }[] = [];
  for (const [proformaId, group] of byProforma) {
    const first = group[0];
    const created = await issueDocumentTx(tx, {
      organizationId: params.organizationId,
      docType: "invoice",
      // Always IVTEN: only the plain tenant invoice group is ever issued as a proforma
      // (issue-grouped.ts), so there is no other series this can graduate onto.
      seriesCode: "IVTEN",
      counterpartyType: "tenant",
      partyId: params.partyId,
      tenancyId: first.document.tenancyId ?? undefined,
      propertyId: first.document.propertyId ?? undefined,
      apartmentId: first.document.apartmentId ?? undefined,
      listingId: first.document.listingId ?? undefined,
      billingMonth: first.document.billingMonth
        ? first.document.billingMonth.toISOString().slice(0, 10)
        : undefined,
      // Keyed on the PROFORMA and the CHARGE SET: one payment settling lines on two
      // proformas mints one invoice per proforma; one payment allocated incrementally
      // mints one per increment; and a literal replay of either still dedupes.
      idempotencyKey: `grad:${params.paymentId}:${proformaId}:${chargeSetDigest(group.map((l) => l.chargeId))}`,
      // The graduation link. NEVER originalDocumentId — see schema.prisma's note on
      // proformaDocumentId for the four paths that would then stop seeing this document.
      proformaDocumentId: proformaId,
      lines: group.map((l) => ({
        chargeId: l.chargeId,
        categoryId: l.categoryId,
        description: l.description,
        amount: l.amount.toString(),
        sstRate: l.sstRate.toString(),
        // Carried over so the SST sibling stays out of subtotal on the invoice exactly as
        // it was on the proforma; otherwise the graduated total would exceed what was billed.
        isTax: l.isTax,
      })),
      actorUserId: params.actorUserId,
    });
    graduated.push(created);
  }

  return { graduated };
}
