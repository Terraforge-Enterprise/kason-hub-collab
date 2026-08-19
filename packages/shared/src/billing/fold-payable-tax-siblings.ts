/**
 * foldPayableTaxSiblings — collapse an SST sibling CHARGE into the base charge it
 * taxes, for the tenant portal's payable list.
 *
 * ─── Why this exists alongside foldTaxLines ──────────────────────────────────
 *
 * `fold-tax-lines.ts` is the same idea one layer up: it folds a document's LINES
 * for a renderer, and its header is the canonical explanation of what an SST
 * sibling is and why it must keep existing as its own Charge. Read that first.
 *
 * This function folds the CHARGES themselves, because the portal's payable list
 * (`listPayableCharges`) has no document context to fold — it reads Charge rows
 * directly. That surface was the one place the fold never reached, so a tenant
 * paying an SST-bearing expense saw two bills:
 *
 *     test ten exp sst                         RM 0.50   OVERDUE
 *     test ten exp sst — SST 8%                RM 0.04   OVERDUE     ← reads as a bug
 *
 * where the invoice they had just been sent showed one line of RM 0.54. Worse,
 * the two were independently tickable in "Select charges" mode, so a tenant who
 * took the second row for a duplicate could pay RM 0.50 and leave the document
 * four sen short of settled forever.
 *
 * ─── Why it returns `components` ─────────────────────────────────────────────
 *
 * The fold is PRESENTATION, but unlike foldTaxLines' callers this one submits
 * money afterwards, so it cannot simply discard the sibling. `validatePayment-
 * AllocationsTx` locks each charge and demands the allocation equal THAT charge's
 * own outstanding to the cent (`ALLOC_BELOW_OUTSTANDING` / `ALLOC_EXCEEDS_-
 * OUTSTANDING`) — so a folded row of RM 0.54 must still submit two allocations,
 * RM 0.50 against the base and RM 0.04 against the sibling. `components` carries
 * exactly that, and is the ONLY thing a caller may build allocations from. Never
 * allocate a folded row's merged `outstandingAmount` against its `id`: the
 * validator would reject the basket, and it is money.
 *
 * ─── What this does NOT need from foldTaxLines ───────────────────────────────
 *
 * foldTaxLines refuses to fold when base and sibling are adjusted OUT OF STEP,
 * because the surfaces it feeds print an Adjustments column and a merged row
 * would hide a note. This list prints no such column — it shows only what is
 * still owed, and `Charge.outstandingAmount` on BOTH charges is already net of
 * every active note (`createChargeAdjustmentService` mirrors each note onto the
 * sibling). Merging two current outstandings is therefore arithmetically right
 * whatever the note history, so no in-step test is needed here.
 *
 * Pure: no I/O, no Date, no floats in the arithmetic (integer cents throughout).
 *
 * SAFETY — money never disappears from view, exactly as in foldTaxLines. A tax
 * charge is folded ONLY when its `parentChargeId` resolves to a NON-tax charge
 * present in the same input. An orphan — base already settled, base outside this
 * page, parent link never written — stays on screen as its own row, because a
 * charge the tenant cannot see is one they never pay.
 */
import { toCents } from "../utils/money-cents";

/** One charge a folded row settles, and the exact amount to allocate against it. */
export type PayableChargeComponent = {
  chargeId: string;
  /** 2-dp money. Equals that charge's OWN outstanding — never the merged figure. */
  outstandingAmount: number;
};

/**
 * The minimum a payable row must expose to be folded. Everything else on the
 * caller's row type is passed through untouched (`chargeNumber`, `description`,
 * `dueDate`, …), and a folded row keeps the BASE charge's values for all of it.
 */
export type FoldablePayableCharge = {
  id: string;
  /** `Charge.parentChargeId`. A GENERIC parent link — see the isTax note below. */
  parentChargeId: string | null;
  /**
   * True when this charge's amount IS tax already declared via its base's rate,
   * i.e. it has an `isTax` BillingDocumentLine.
   *
   * ⚠️ `parentChargeId` alone must NEVER be used to identify a tax sibling. It is
   * a generic lineage link that non-tax charges also use — `correction-replace.
   * service.ts` points an `RPL-…` replacement charge at the charge it supersedes.
   * Folding on the link alone would silently merge a replacement into the charge
   * it replaced. Same rule `findTaxSibling` enforces in charge-adjustment.service.
   */
  isTax: boolean;
  /** 2-dp money, tax-exclusive on a base charge. */
  amount: number;
  /** 2-dp money. */
  outstandingAmount: number;
  /** This charge already carries a payment claim awaiting a human. */
  pendingVerification: boolean;
};

/** A display row: the base charge, plus the charges a payment must be split across. */
export type FoldedPayableCharge<T> = T & { components: PayableChargeComponent[] };

export type FoldPayableOptions<T> = {
  /**
   * Extra numeric fields to sum from the siblings into the base, on top of `amount`
   * and `outstandingAmount`.
   *
   * ⚠️ MONEY. A surface with its own per-charge CN/DN columns MUST name them here.
   * `createChargeAdjustmentService` mirrors every note onto the SST sibling, so the
   * sibling holds its own share of the credit: fold the pair without merging those
   * and the Total column understates the credit note while the row still shows the
   * merged outstanding — the invoice stops footing by eye, which is the exact defect
   * foldTaxLines was written to kill one layer up.
   *
   * A named field the base does not carry is skipped, not defaulted to 0, so a
   * partial projection round-trips unchanged.
   */
  alsoMerge?: readonly (keyof T & string)[];
};

const selfComponent = <T extends FoldablePayableCharge>(r: T): PayableChargeComponent => ({
  chargeId: r.id,
  outstandingAmount: r.outstandingAmount,
});

/**
 * Returns the display rows for `charges`: foldable tax siblings removed, their
 * `amount` and `outstandingAmount` merged into the base they tax, and every row
 * given the `components` a payment must be allocated across. Input is never
 * mutated. Order is preserved — folding only removes rows, never reorders them.
 */
export function foldPayableTaxSiblings<T extends FoldablePayableCharge>(
  charges: readonly T[],
  options?: FoldPayableOptions<T>,
): FoldedPayableCharge<T>[] {
  // Fast path — the overwhelming majority of baskets carry no tax charge at all,
  // and must come back in the same order with one self-component each.
  if (!charges.some((c) => c.isTax)) {
    return charges.map((c) => ({ ...c, components: [selfComponent(c)] }));
  }

  // id → the NON-tax charge it identifies. Tax charges are excluded as hosts: tax
  // is not taxed again (the sibling is minted with sstRate "0"), so a tax charge
  // parented to another tax charge is a shape we do not understand — and the
  // SAFETY rule says show what we do not understand rather than hide it.
  const baseById = new Map<string, T>();
  for (const c of charges) {
    if (!c.isTax) baseById.set(c.id, c);
  }

  const foldedAway = new Set<string>();
  const mergedInto = new Map<string, T[]>();

  for (const c of charges) {
    if (!c.isTax) continue;
    const base = c.parentChargeId ? baseById.get(c.parentChargeId) : undefined;
    // Orphan — base not in this basket, or the parent link is missing/points at a
    // tax charge. Keep the row: its money is real and must remain payable.
    if (!base) continue;
    foldedAway.add(c.id);
    const siblings = mergedInto.get(base.id);
    if (siblings) siblings.push(c);
    else mergedInto.set(base.id, [c]);
  }

  const out: FoldedPayableCharge<T>[] = [];
  for (const c of charges) {
    if (foldedAway.has(c.id)) continue;
    const siblings = mergedInto.get(c.id);
    if (!siblings) {
      out.push({ ...c, components: [selfComponent(c)] });
      continue;
    }
    // ⚠️ MONEY. Integer cents, never float addition: 0.1 + 0.2 is
    // 0.30000000000000004, which fails the pay schema's 2-decimal regex the
    // moment it is stringified into an allocation.
    let amountC = toCents(c.amount, "foldPayableTaxSiblings.amount");
    let outstandingC = toCents(c.outstandingAmount, "foldPayableTaxSiblings.outstanding");
    for (const s of siblings) {
      amountC += toCents(s.amount, "foldPayableTaxSiblings.taxAmount");
      outstandingC += toCents(s.outstandingAmount, "foldPayableTaxSiblings.taxOutstanding");
    }
    // Caller-named money columns (CN/DN sums and their derived total). Same integer
    // cents; a field absent from the base is left absent rather than zeroed.
    const merged: Record<string, number> = {};
    for (const field of options?.alsoMerge ?? []) {
      const baseValue = (c as Record<string, unknown>)[field];
      if (typeof baseValue !== "number") continue;
      let cents = toCents(baseValue, `foldPayableTaxSiblings.${field}`);
      for (const s of siblings) {
        const sv = (s as Record<string, unknown>)[field];
        if (typeof sv === "number") cents += toCents(sv, `foldPayableTaxSiblings.tax.${field}`);
      }
      merged[field] = cents / 100;
    }
    out.push({
      ...c,
      ...merged,
      amount: amountC / 100,
      outstandingAmount: outstandingC / 100,
      // OR, never AND. If either half already carries a claim awaiting a human,
      // the merged row must not present itself as payable — the tenant would be
      // invited to pay the same money twice and the validator would reject the
      // whole basket with CHARGE_PENDING_VERIFICATION.
      pendingVerification: c.pendingVerification || siblings.some((s) => s.pendingVerification),
      // Base first, then siblings in input order — deterministic, so a basket
      // submitted twice locks the same charges in the same sequence.
      components: [selfComponent(c), ...siblings.map(selfComponent)],
    });
  }
  return out;
}
