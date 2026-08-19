/**
 * adjustmentTargetLines — the lines a credit/debit note may be raised AGAINST.
 *
 * Sibling of `fold-tax-lines.ts`, which explains what an SST sibling line IS and why
 * it must keep existing. Read that header first; this file only answers a narrower
 * question: which of those lines belong in the CN/DN "Line item" picker.
 *
 * ─── Why a tax line must not be offered ──────────────────────────────────────
 *
 * `createChargeAdjustmentService` MIRRORS every note onto the base charge's `-SST`
 * sibling — it finds the sibling (`findTaxSibling`) and moves its outstanding by the
 * note's own tax (`taxSiblingMirror`), inside the same transaction. So crediting
 * RM 1.00 of an 8% charge already relieves the RM 0.08 sibling; the note's printed
 * total (1.00 + 0.08 SST) says so.
 *
 * Offering the sibling as a SEPARATE pickable line therefore invites the operator to
 * relieve the same RM 0.08 twice — once by hand, once by the mirror — and the second
 * relief is not a harmless no-op. The sibling CHARGE is clamped at zero outstanding,
 * but the two NOTES both declare their tax, so the org ends up declaring RM 0.16 of
 * relief against RM 0.08 of tax it ever charged: wrong on the invoice, wrong in the
 * owner ledger's note netting, wrong to LHDN.
 *
 * The picker is also just confusing without it — an SST-bearing RM 1.00 expense shows
 * up as two choices, "… — RM 1.00" and "… — SST 8% — RM 0.08", with nothing on screen
 * saying the second one is handled for you.
 *
 * ─── What stays offered ──────────────────────────────────────────────────────
 *
 * A tax line is hidden ONLY when a note raised on its base would actually reach it —
 * the same condition the server mirrors on:
 *
 *   • its base line is on THIS document (`findTaxSibling` looks for the tax line and
 *     the sibling Charge on one document — a tax line whose base was invoiced
 *     elsewhere can never be mirrored, so it must stay directly adjustable), and
 *   • that base line carries a non-zero `sstRate` (`taxSiblingMirror` returns null
 *     when the note's tax rounds to zero cents, and a zero rate always does — so a
 *     sibling hanging off a zero-rate base would otherwise become unreachable).
 *
 * Anything else stays in the list. FAIL OPEN: an unparseable rate keeps the line
 * offered, because an operator who cannot reach a live receivable is worse off than
 * one shown a row they must think about.
 *
 * Charge-less lines (overpayment CN, `chargeId: null`) are dropped outright — the
 * endpoint is charge-scoped (spec §7-A1) and has nothing to key on without one.
 *
 * Pure: no I/O, no Date, no money arithmetic — this decides visibility only.
 */

/** The minimum a line must expose for the picker rule. A subset of
 * `BillingDocumentLineDto`, so the DTO satisfies it structurally. */
export type AdjustmentTargetLine = {
  /** The Charge a note would be raised against. Null ⇒ never a target. */
  chargeId: string | null;
  /** True when this line's amount IS tax a sibling line contributed via its rate. */
  isTax: boolean;
  /** `Charge.parentChargeId` of a tax line — the base charge it taxes. Null on every
   * non-tax line, and on a tax line whose parent link was never written. */
  taxParentChargeId: string | null;
  /** The line's own SST rate as a decimal string ("8", "0"). Read from the BASE line
   * to decide whether a mirror would carry any tax at all. */
  sstRate: string;
};

/**
 * Returns the subset of `lines` a charge-scoped credit/debit note may target: every
 * charge-backed line, minus the SST siblings the server already moves on its own.
 * Input is never mutated.
 */
export function adjustmentTargetLines<T extends AdjustmentTargetLine>(lines: readonly T[]): T[] {
  // chargeId → the rate on the line that settles it. First wins, matching
  // foldTaxLines' tie-break for a charge itemised across several display lines.
  const baseSstRateByCharge = new Map<string, string>();
  for (const l of lines) {
    if (l.isTax || !l.chargeId) continue;
    if (!baseSstRateByCharge.has(l.chargeId)) baseSstRateByCharge.set(l.chargeId, l.sstRate);
  }

  return lines.filter((l) => {
    if (l.chargeId === null) return false;
    if (!l.isTax) return true;
    const baseRate = l.taxParentChargeId ? baseSstRateByCharge.get(l.taxParentChargeId) : undefined;
    // Orphan — the base is not on this document, so no mirror can ever reach this
    // tax charge. It holds real money; it must stay adjustable by hand.
    if (baseRate === undefined) return true;
    // Kept when the rate is zero (no mirror would fire) or unparseable (fail open).
    return !(Number(baseRate) > 0);
  });
}
