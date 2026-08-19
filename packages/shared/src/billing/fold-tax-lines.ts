/**
 * foldTaxLines — collapse an SST sibling line into the base line it taxes.
 *
 * ─── Why a tax line exists at all ────────────────────────────────────────────
 *
 * `mintExpenseChargesTx` (bills-grid/service.ts) mints an SST-bearing grid expense
 * as TWO Charges: the base, and a sibling whose amount IS the tax. That sibling is
 * a money fix, not an accident — before it, `issueDocumentTx` derived the tax from
 * the base line's rate and added it to the document total, but nothing ever wrote
 * that money to a Charge. The tax was invoiced, owed by the payer and declared to
 * LHDN, yet had NO row a payment could settle: absent from the portal's payable
 * list, excluded from balance-due, and invisible to `deriveDocumentStatus`, which
 * flipped the invoice to "settled" the moment only the BASE was paid.
 *
 * So the sibling Charge — and its document line — MUST keep existing. It is what
 * the Record-Payment form allocates against and what `deriveDocumentStatus` counts.
 *
 * ─── Why it must not be RENDERED ─────────────────────────────────────────────
 *
 * `issueDocumentTx` already excludes an `isTax` line from `subtotal` (its amount is
 * tax the base line contributed via its own `sstRate` — counting it twice would put
 * the same money in `total` twice). Every human-facing renderer, however, printed it
 * as an ordinary third line item. The result was an invoice that could not be
 * reconciled by eye:
 *
 *     #  Description       Amount   SST
 *     1  1                 RM 1.00  RM 0.08     ← the tax, shown here…
 *     2  1 — SST 8%        RM 0.08    —         ← …and AGAIN here
 *     3  1                 RM 0.80    —
 *                          -------
 *        Σ Amount column   RM 1.88
 *        Subtotal printed  RM 1.80              ← refuses to foot
 *
 * Folding restores the invariant a reader checks by hand:
 *
 *     Σ(Amount) === subtotal   ·   Σ(SST) === sstAmount   ·   Σ(Outstanding) === balance
 *
 * ─── Contract ────────────────────────────────────────────────────────────────
 *
 * PRESENTATION ONLY. Call this at the moment of rendering — never on the way into
 * `record-invoice-payment-form` (which allocates a payment across lines) or
 * correct-invoice (which seeds replacement lines). Folding there would make the tax
 * charge unallocatable and reopen the very bug the sibling exists to fix.
 *
 * The adjustments tab's CN/DN picker is NOT one of those callers and must not use
 * this function either — a tax line whose base is adjusted out of step un-folds here
 * (see the loop), and that is precisely the line still needing adjustment by hand.
 * It uses `adjustmentTargetLines` (adjustment-target-lines.ts), which asks the
 * different question "would a note on the base already move this row?".
 *
 * Pure: no I/O, no Date, no floats. Settlement figures are merged in integer cents.
 *
 * SAFETY — money never disappears from view. A tax line is folded ONLY when its
 * base line is present on the same document AND the two are adjusted IN STEP (both
 * carry active notes, or neither does — see the loop). Anything else stays visible,
 * because a row the reader cannot see is worse than a row they cannot immediately
 * explain.
 */
import { centsToString, toCents } from "../utils/money-cents";

/**
 * The minimum a line must expose to be folded. Settlement fields are OPTIONAL so
 * the same function serves the PDF model (which prints Amount + SST only and has no
 * settlement columns to merge into) and the screen DTO (which has both).
 */
export type TaxFoldableLine = {
  /** Stable identity — used to match a parent without relying on array position. */
  id: string;
  /** The Charge this line settles. Null for a charge-less line (overpayment CN). */
  chargeId: string | null;
  /** True when this line's amount IS tax already counted via a sibling's rate. */
  isTax: boolean;
  /** `Charge.parentChargeId` of the tax sibling — the base charge it taxes. Null on
   * every non-tax line, and on a tax line whose parent link was never written. */
  taxParentChargeId: string | null;
  /** 2-dp string. Merged into the base line when present. */
  paid?: string;
  /** 2-dp string. Merged into the base line when present. */
  outstanding?: string;
  /** Active notes touching this line's charge. A tax line carrying any is NEVER
   * folded — hiding it would hide the adjustment with it. */
  adjustments?: readonly unknown[];
};

/**
 * Returns the display rows for `lines`: tax siblings removed, their `paid` and
 * `outstanding` merged into the base line they tax. Input is never mutated; a
 * document with no tax line is returned as an equivalent copy.
 */
export function foldTaxLines<T extends TaxFoldableLine>(lines: readonly T[]): T[] {
  // Fast path — the overwhelming majority of documents carry no tax line at all,
  // and must come back byte-identical.
  if (!lines.some((l) => l.isTax)) return [...lines];

  // chargeId → the line that settles it. First wins: a charge itemised across
  // several display lines (meter path) folds its tax into the first, keeping the
  // merge deterministic rather than dependent on which line the loop saw last.
  const baseLineByCharge = new Map<string, T>();
  for (const l of lines) {
    if (l.isTax || !l.chargeId) continue;
    if (!baseLineByCharge.has(l.chargeId)) baseLineByCharge.set(l.chargeId, l);
  }

  const foldedAway = new Set<string>();
  const mergedPaidC = new Map<string, number>();
  const mergedOutstandingC = new Map<string, number>();

  for (const l of lines) {
    if (!l.isTax) continue;
    const base = l.taxParentChargeId ? baseLineByCharge.get(l.taxParentChargeId) : undefined;
    // Orphan: the base line is not on this document (or the parent link is missing).
    // Keep the tax line rendered — its money is real and must remain on screen.
    if (!base) continue;
    // ── Fold only when base and tax are adjusted IN STEP ──────────────────────
    //
    // charge-adjustment.service.ts now mirrors every note onto the base charge's
    // `-SST` sibling, so the pair moves together and a folded row tells the whole
    // truth. Two states break that, and each must stay visible (SAFETY above):
    //
    //   tax adjusted, base NOT — someone raised a note directly on the tax charge.
    //     It is a standalone correction; folding would hide it entirely.
    //   base adjusted, tax NOT — a note minted BEFORE the mirror existed (or whose
    //     sibling was since voided). This is the state the old unconditional
    //     `base.adjustments` guard existed for: the sibling still holds the full
    //     original tax while the base reads adjusted, and folding would leave an
    //     unexplained residue on the base row.
    //
    // Equality covers both, and collapses to the previous behaviour when neither
    // carries a note — the overwhelmingly common case.
    const taxAdjusted = (l.adjustments?.length ?? 0) > 0;
    const baseAdjusted = (base.adjustments?.length ?? 0) > 0;
    if (taxAdjusted !== baseAdjusted) continue;
    // FAIL CLOSED: only fold when the base can actually RECEIVE every settlement figure
    // the tax line carries. These fields are optional so one helper can serve both the
    // screen DTO and the settlement-less PDF model — which means a caller can legitimately
    // present a base with no `paid` and a tax line with one (a partial projection, an
    // export mapper). Removing the row while silently discarding its money is the single
    // outcome the SAFETY contract above forbids; keeping a row the reader must reconcile
    // by hand is strictly better than losing it.
    if (l.paid !== undefined && base.paid === undefined) continue;
    if (l.outstanding !== undefined && base.outstanding === undefined) continue;

    foldedAway.add(l.id);
    if (l.paid !== undefined) {
      mergedPaidC.set(base.id, (mergedPaidC.get(base.id) ?? 0) + toCents(l.paid, "foldTaxLines.taxPaid"));
    }
    if (l.outstanding !== undefined) {
      mergedOutstandingC.set(
        base.id,
        (mergedOutstandingC.get(base.id) ?? 0) + toCents(l.outstanding, "foldTaxLines.taxOutstanding"),
      );
    }
  }

  return lines
    .filter((l) => !foldedAway.has(l.id))
    .map((l) => {
      const paidC = mergedPaidC.get(l.id);
      const outstandingC = mergedOutstandingC.get(l.id);
      if (paidC === undefined && outstandingC === undefined) return l;
      return {
        ...l,
        ...(paidC !== undefined && l.paid !== undefined
          ? { paid: centsToString(toCents(l.paid, "foldTaxLines.basePaid") + paidC) }
          : {}),
        ...(outstandingC !== undefined && l.outstanding !== undefined
          ? { outstanding: centsToString(toCents(l.outstanding, "foldTaxLines.baseOutstanding") + outstandingC) }
          : {}),
      };
    });
}
