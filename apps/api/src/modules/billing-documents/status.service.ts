// apps/api/src/modules/billing-documents/status.service.ts
//
// Settlement status is DERIVED from the linked charges' outstanding (spec
// §4.1 immutability contract) — payments stay untouched by this design.
// refreshDocumentStatusForCharges is a post-commit, flag-gated, never-throw
// hook (same contract as owner-ledger.sync-hook.ts): called after payments
// allocate/post/void/reverse commit, and by Plan 3 after CN issuance.

import { getDb, Prisma } from "@kason/db";
import { toCents, ACTIVE_ADJUSTMENT_NOTE_STATUSES, CASH_ALLOCATION_WHERE } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { sumReversalsForAllocations } from "../payments/payments.repository";

export type DocumentSettlementStatus = "issued" | "partially_settled" | "settled" | "offset";

/**
 * Document types that carry NO payment axis, so settlement is never derived for them.
 *
 * - credit_note / refund_note — reversal artifacts, not receivables
 * - receipt                   — records a payment already made
 * - owner_expense_advice      — records money already DEDUCTED from the owner's payout;
 *                               it is evidence, never a receivable. Deriving settlement
 *                               would show an OEA as "Unpaid" in the register and pollute
 *                               the owner's outstanding balance.
 *
 * An ALLOWLIST of non-receivables rather than a denylist of receivables: a docType added
 * in future defaults to being derived (visible, possibly wrong) rather than silently
 * skipped (invisible, certainly wrong).
 */
export function isNonReceivableDocType(docType: string): boolean {
  return docType === "credit_note"
    || docType === "refund_note"
    || docType === "receipt"
    || docType === "owner_expense_advice"
    // Proforma spec R2. THE guard that makes the proforma model safe: a proforma and
    // the invoice graduated from it reference the SAME charges, so if settlement were
    // derived on both, every Σ over documents would count that money twice. A proforma
    // is a dated snapshot of what was owed, not a receivable — the receivable lives on
    // Charge, and the tenant portal pays charges, never documents.
    || docType === "proforma";
}

/** Pure derivation over the document's linked charges. */
export function deriveDocumentStatus(
  charges: { status: string; amountCents: number; outstandingCents: number }[],
): DocumentSettlementStatus {
  if (charges.length === 0) return "issued";
  if (charges.every((c) => c.status === "credited")) return "offset";
  const allSettled = charges.every(
    (c) => c.outstandingCents === 0 && (c.status === "paid" || c.status === "credited"),
  );
  if (allSettled) return "settled";
  const anyCollected = charges.some(
    (c) => c.outstandingCents < c.amountCents || c.status === "paid" || c.status === "partially_paid",
  );
  return anyCollected ? "partially_settled" : "issued";
}

/**
 * Legacy settlement `status` → derived `settlementStatus` axis (R6/R7).
 * OVERPAID is NOT in this map — it is detected separately in the hook from the
 * money rows (Σ cleared allocations − reversals vs invoice amount). Any
 * unexpected legacy value falls back to UNPAID (never throws — the hook is a
 * never-throw projection).
 */
export function mapSettlementStatus(legacy: string): string {
  const SETTLEMENT_MAP: Record<string, string> = {
    issued: "UNPAID",
    partially_settled: "PARTIALLY_PAID",
    settled: "PAID",
    offset: "PAID",
  };
  return SETTLEMENT_MAP[legacy] ?? "UNPAID";
}

/**
 * Null-safe chargeId extraction for the settlement recompute. Overpayment-CN
 * lines (R12a) carry chargeId=null; a null must never enter a Prisma
 * `{ id: { in: [...] } }` clause (it would throw, then be swallowed at :70,
 * leaving the doc's status stale). Filters to a clean string[].
 */
export function chargeIdsForFindMany(lines: { chargeId: string | null }[]): string[] {
  return lines.map((l) => l.chargeId).filter((id): id is string => id !== null);
}

/**
 * Canonical in-tx derivation (§7-A3 / Issue 3): recompute ONE document's status from
 * ALL its charges and write BOTH axes (legacy `status` + derived `settlementStatus`)
 * consistently — never one axis alone. OVERPAID stays the post-commit hook's job.
 * deriveDocumentStatus([]) === "issued" (guarded), so an empty charge set can never
 * produce a false "offset". Used by the CN/DN correction paths so crediting ONE charge
 * of a grouped invoice never blanket-`offset`s the whole document.
 */
export async function deriveAndWriteDocumentStatusTx(
  tx: Prisma.TransactionClient,
  docId: string,
): Promise<void> {
  const lines = await tx.billingDocumentLine.findMany({
    where: { documentId: docId },
    select: { chargeId: true },
  });
  const chargeIds = chargeIdsForFindMany(lines);
  const charges = chargeIds.length
    ? await tx.charge.findMany({
        where: { id: { in: chargeIds } },
        select: { status: true, amount: true, outstandingAmount: true },
      })
    : [];
  const status = deriveDocumentStatus(
    charges.map((c) => ({
      status: c.status,
      amountCents: toCents(c.amount.toString(), "deriveAndWrite.amount"),
      outstandingCents: toCents(c.outstandingAmount.toString(), "deriveAndWrite.outstanding"),
    })),
  );
  await tx.billingDocument.update({
    where: { id: docId },
    data: { status, settlementStatus: mapSettlementStatus(status) },
  });
}

/**
 * Recompute the status of every document linked (via lines) to the given
 * charges. CN/RN documents and terminal "offset" documents are skipped.
 * Never throws — a failure only logs (status is a projection; the next
 * settle/void re-derives it).
 */
export async function refreshDocumentStatusForCharges(chargeIds: string[]): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return;
  if (!chargeIds || chargeIds.length === 0) return;
  try {
    const db = getDb();
    const lines = await db.billingDocumentLine.findMany({
      where: { chargeId: { in: chargeIds } },
      select: { documentId: true },
    });
    const docIds = [...new Set(lines.map((l) => l.documentId))];
    for (const docId of docIds) {
      const doc = await db.billingDocument.findUnique({
        where: { id: docId },
        select: {
          id: true, organizationId: true, status: true, docType: true, counterpartyType: true,
          lines: { select: { chargeId: true } },
        },
      });
      if (!doc) continue;
      // §7-A6 / D9 gate: `offset` is a DERIVED (non-terminal) status for TENANT docs, so
      // Phase-4 un-void can re-derive them away from offset. It stays TERMINAL for OWNER
      // IVOWN docs, whose offset is set manually by statement-reversal WITHOUT crediting the
      // underlying charges ("Child line Charges are left as-is", owner-billing.service.ts) —
      // re-deriving those would un-offset a voided owner statement (owner-accounting corruption).
      if (doc.status === "offset" && doc.counterpartyType === "owner") continue;
      if (isNonReceivableDocType(doc.docType)) continue;
      const docChargeIds = chargeIdsForFindMany(doc.lines);
      const charges = await db.charge.findMany({
        where: { id: { in: docChargeIds } },
        select: { status: true, amount: true, outstandingAmount: true },
      });
      const next = deriveDocumentStatus(
        charges.map((c) => ({
          status: c.status,
          amountCents: toCents(c.amount.toString(), "refreshDocumentStatus.amount"),
          outstandingCents: toCents(c.outstandingAmount.toString(), "refreshDocumentStatus.outstanding"),
        })),
      );

      // Derived settlementStatus (R6/R7): the legacy `next` mapped, EXCEPT
      // OVERPAID — detected separately from the money rows BEFORE any outstanding
      // clamp. Overpayment = Σ(cleared PaymentAllocation.allocatedAmount for this
      // doc's charges, payment posted) − Σ(PaymentAllocationReversal.amount) >
      // Σ(charge amount / adjusted invoice amount). Reversal sums come from ONE
      // grouped query (no N+1, R11).
      const allocs = docChargeIds.length
        ? await db.paymentAllocation.findMany({
            where: {
              organizationId: doc.organizationId,
              chargeId: { in: docChargeIds },
              ...CASH_ALLOCATION_WHERE,
            },
            select: { id: true, allocatedAmount: true },
          })
        : [];
      const reversed = await sumReversalsForAllocations(
        db,
        doc.organizationId,
        allocs.map((a) => a.id),
      );
      const clearedCents = allocs.reduce(
        (s, a) =>
          s +
          toCents(a.allocatedAmount.toString(), "refreshDocumentStatus.alloc") -
          Math.round((reversed.get(a.id) ?? 0) * 100),
        0,
      );
      // OVERPAID basis = adjustedInvoiceAmount (spec R7), NOT Σ charge.amount:
      //   adjusted = Σ(charge.amount) + Σ(DN line amounts) − Σ(CN line amounts)
      // for THIS doc's charges. `charge.amount` never moves when a Debit/Credit
      // Note is issued (DN/CN adjust `outstandingAmount`, not `amount`), so a plain
      // Σ charge.amount both false-positives (debit-adjusted invoice paid in full)
      // and false-negatives (credit-noted invoice overpaid). DN/CN adjustments are
      // read from BillingDocumentLine rows whose chargeId ∈ this doc's charges,
      // joined to their parent BillingDocument's docType — ONE bounded findMany
      // (no N+1, R11).
      const invoiceCents = charges.reduce(
        (s, c) => s + toCents(c.amount.toString(), "refreshDocumentStatus.invoiceAmount"),
        0,
      );
      // §7-A5: key adjustment notes by originalDocumentId (matching Formula B in
      // derive-for-docs), active lifecycle + charge-backed — so a note linked to ANOTHER
      // document never alters THIS doc's basis even when a charge is shared across ancestry,
      // and CANCELLED/SUPERSEDED (or any non-ISSUED) notes drop out. Sum SST-exclusive line
      // amounts (settlement basis); overpayment CNs (all lines chargeId=null) are excluded.
      const adjustmentNotes = await db.billingDocument.findMany({
        where: {
          organizationId: doc.organizationId,
          originalDocumentId: doc.id,
          docType: { in: ["debit_note", "credit_note"] },
          documentStatus: { in: [...ACTIVE_ADJUSTMENT_NOTE_STATUSES] },
          lines: { some: { chargeId: { not: null } } },
        },
        select: { docType: true, lines: { select: { amount: true } } },
      });
      const adjustmentCents = adjustmentNotes.reduce((s, n) => {
        const noteCents = n.lines.reduce(
          (ls, l) => ls + toCents(l.amount.toString(), "refreshDocumentStatus.adjustment"),
          0,
        );
        return n.docType === "debit_note" ? s + noteCents : s - noteCents;
      }, 0);
      const adjustedInvoiceCents = invoiceCents + adjustmentCents;
      const settlementStatus =
        clearedCents > adjustedInvoiceCents ? "OVERPAID" : mapSettlementStatus(next);

      // settlementStatus is a derived cache — always dual-write it (its own
      // change-detection would be redundant); the legacy `status` rides along in
      // the SAME update, its behavior unchanged (existing readers depend on it).
      await db.billingDocument.update({
        where: { id: doc.id },
        data: { status: next, settlementStatus },
      });
    }
  } catch (e) {
    console.error("[billing-documents.status] refresh failed (swallowed):", e);
  }
}
