/**
 * The reference a TENANT should see for a charge — the number on the bill they
 * were sent, never an internal id.
 *
 * ─── The leak this closes ────────────────────────────────────────────────────
 *
 * `Charge.chargeNumber` is an internal key, and for grid-minted charges it embeds
 * raw UUIDs:
 *
 *     GRIDEXP-202608-360f0307-7426-412f-b362-3e500534b44d-SST
 *     GRIDUTIL-202608-6727b8fb-ef4a-4821-8b58-a1dcfdeeae07-ELECTRICITY
 *
 * The portal's surfaces rendered `invoiceNumber ?? chargeNumber`, and grid mints
 * never set `Charge.invoiceId` — they attach to BillingDocuments, not the legacy
 * `Invoice` table — so EVERY grid row fell through to the internal id. A tenant
 * looking at their pay screen saw nine UUIDs and no way to match any of them to
 * the invoice in their inbox.
 *
 * The real reference lives on the document: `BillingDocumentLine.chargeId` →
 * `BillingDocument.documentNumber` (IVTEN-0002, DEP-2026-0007). That is the number
 * printed on the PDF they received, so it is the only one worth showing.
 *
 * ─── Which document, when a charge has several ───────────────────────────────
 *
 * A charge accumulates documents over its life: the invoice that billed it, debit
 * notes, credit notes, a receipt. Only a BILL is a useful reference:
 *
 *   invoice     → the bill. Preferred.
 *   debit_note  → also a bill the counterparty owes (the Invoices register
 *                 deliberately spans both — DEP-series rent/utility bills sit
 *                 under debit_note via the pay_back_landlord family).
 *   credit_note / refund_note / receipt / owner_expense_advice → NOT the bill.
 *                 Referencing a tenant's charge by its credit note would tell them
 *                 to go looking at the document that REDUCED it.
 *
 * Earliest-issued wins within a tier: after a re-bill the tenant is chasing the
 * bill they were first sent, not the newest revision.
 */

import type { getDb } from "@kason/db";

/** One document a charge appears on. `issuedAt` accepts a Date or an ISO string so
 * the same picker serves a Prisma row and a JSON round-trip. */
export type ChargeDocumentRef = {
  documentNumber: string;
  docType: string;
  issuedAt: Date | string;
};

/** Doc types that ARE a bill, best first. Anything else is not a reference. */
const BILL_DOC_TYPES_BY_PREFERENCE = ["invoice", "debit_note"] as const;

const asTime = (v: Date | string): number =>
  typeof v === "string" ? Date.parse(v) : v.getTime();

/**
 * The tenant-facing reference for a charge, or `null` when the charge is on no
 * bill yet. Callers MUST render something human on null (description + due date)
 * rather than falling back to `chargeNumber` — that fallback IS the leak.
 */
export function pickTenantBillReference(docs: readonly ChargeDocumentRef[]): string | null {
  for (const docType of BILL_DOC_TYPES_BY_PREFERENCE) {
    const candidates = docs.filter((d) => d.docType === docType);
    if (candidates.length === 0) continue;
    // Earliest issued wins; ties broken by documentNumber so the reference can
    // never flip between two page loads for the same charge.
    return candidates.reduce((best, d) => {
      const dt = asTime(d.issuedAt);
      const bt = asTime(best.issuedAt);
      if (dt !== bt) return dt < bt ? d : best;
      return d.documentNumber < best.documentNumber ? d : best;
    }).documentNumber;
  }
  return null;
}

/**
 * chargeId → tenant-facing bill reference, for a page of charges. Charges on no
 * bill are simply absent from the map (the caller renders a human fallback).
 *
 * ONE grouped query for the whole page, not one per row — the same shape the
 * pending-verification lookup in portal.payments.repository uses.
 */
export async function resolveTenantBillReferences(
  db: ReturnType<typeof getDb>,
  orgId: string,
  chargeIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (chargeIds.length === 0) return out;

  // `document: { organizationId }` IS expressible here: BillingDocumentLine has a
  // real relation to BillingDocument. It is `chargeId` that is a plain column with
  // no Charge relation, which is why that side is an `in` list.
  const lines = await db.billingDocumentLine.findMany({
    where: { chargeId: { in: chargeIds }, document: { organizationId: orgId } },
    select: {
      chargeId: true,
      document: { select: { docType: true, documentNumber: true, issuedAt: true } },
    },
  });

  const byCharge = new Map<string, ChargeDocumentRef[]>();
  for (const l of lines) {
    if (!l.chargeId) continue;
    const list = byCharge.get(l.chargeId);
    if (list) list.push(l.document);
    else byCharge.set(l.chargeId, [l.document]);
  }
  for (const [chargeId, docs] of byCharge) {
    const ref = pickTenantBillReference(docs);
    if (ref) out.set(chargeId, ref);
  }
  return out;
}
