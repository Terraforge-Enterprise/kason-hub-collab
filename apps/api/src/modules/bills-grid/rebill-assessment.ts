/** A live issued charge, narrowed to what payment-state assessment needs. `documentId` is the id
 *  of the charge's OWN live document (the exact linkage service.ts already resolved), or null for a
 *  doc-less charge. Structurally satisfied by service.ts's LiveGridCharge. */
export type AssessCharge = { id: string; partyId: string; family: string | null; amount: number; documentId?: string | null };

/** A live head-of-chain document, narrowed. `id` is the primary key a charge's `documentId` points
 *  at. Structurally satisfied by service.ts's ReclaimableDoc. */
export type AssessDoc = { id: string; counterpartyType: string; documentNumber: string; partyId: string | null };

/** One paid/partially-paid document that blocks a re-Bill. */
// PaidBlocker now lives in @kason/shared (constants/bill-outcomes.ts) — ONE declaration
// shared with the web, which used to hand-copy it. Re-exported so existing imports hold.
import type { PaidBlocker } from "@kason/shared";
export type { PaidBlocker };

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const counterpartyOf = (family: string | null): "tenant" | "owner" => (family === "owner_income" ? "owner" : "tenant");

/**
 * PURE — no I/O, no mutation. Given the unit-month's live charges, their live documents, and the
 * net-of-reversal active paid amount per charge, return one PaidBlocker per document that carries
 * any active payment. A charge maps to its OWN document by `documentId` (exact) — the same linkage
 * service.ts already resolved per charge — never by (counterparty, partyId), which would collapse
 * two live docs sharing (counterparty, partyId) in one unit-month (a utility IVTEN and a tenant
 * Expense Bill EB) onto whichever doc is first and mis-name the block with an inflated total.
 * `invoiceTotal` is the document's total: the sum of that document's grid charges, which for a
 * grid-issued doc equals its stored document total. A charge with NO `documentId` (doc-less, e.g. a
 * legacy owner-borne charge, or a documentId that matches no doc) falls back to grouping by
 * (counterparty, partyId) with invoiceNumber: null, so the message can still name the counterparty +
 * amount. Emits [] when nothing is actively paid.
 */
export function assessPaidBlockers(input: {
  charges: AssessCharge[];
  docs: AssessDoc[];
  activePaidByChargeId: Map<string, number>;
}): { paidBlockers: PaidBlocker[] } {
  const { charges, docs, activePaidByChargeId } = input;
  type Group = { counterparty: "tenant" | "owner"; documentId: string | null; invoiceNumber: string | null; total: number; paid: number };
  const groups = new Map<string, Group>();
  for (const c of charges) {
    // Exact linkage: group by the charge's OWN document. Fall back to (counterparty, partyId) only
    // for a doc-less charge (no documentId, or one that matches no doc).
    const ownDoc = c.documentId != null ? docs.find((d) => d.id === c.documentId) : undefined;
    const counterparty = ownDoc ? (ownDoc.counterpartyType === "owner" ? "owner" : "tenant") : counterpartyOf(c.family);
    const invoiceNumber = ownDoc ? ownDoc.documentNumber : null;
    const key = ownDoc ? `doc:${ownDoc.id}` : `party:${counterparty}:${c.partyId}`;
    const g = groups.get(key) ?? { counterparty, documentId: ownDoc?.id ?? null, invoiceNumber, total: 0, paid: 0 };
    g.total = round2(g.total + c.amount);
    g.paid = round2(g.paid + (activePaidByChargeId.get(c.id) ?? 0));
    groups.set(key, g);
  }
  const paidBlockers: PaidBlocker[] = [];
  for (const g of groups.values()) {
    if (g.paid > 0.005) {
      paidBlockers.push({
        counterparty: g.counterparty,
        documentId: g.documentId,
        invoiceNumber: g.invoiceNumber,
        paidAmount: g.paid,
        invoiceTotal: g.total,
        paymentState: g.paid + 0.005 >= g.total ? "paid" : "partial",
      });
    }
  }
  return { paidBlockers };
}
