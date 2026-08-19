// packages/shared/src/finance/owner-net-payout.ts
//
// Pure finance helper — Net-Rental After Expenses vs Net-Payout to Owner.
//
// The key distinction:
//   Net Rental After Expenses = gross income − ALL expense lines
//   Net Payout to Owner       = gross income − expenses where includeInPayout is TRUE
//
// Owner-paid expenses (e.g. government assessments, quit rent) are recorded in
// the ledger with includeInPayout:false so they appear in financial reporting
// (Net Rental) but are NOT deducted again from the cash payout to the owner —
// the owner already paid those directly.
//
// Money arithmetic uses integer cents via the shared money-cents primitive to
// avoid floating-point drift.

import { toCents, centsToString } from "../utils/money-cents";

export type OwnerLedgerLine = {
  direction: "income" | "expense" | "payout";
  category: string;
  amount: string;
  sstAmount?: string | null;
  includeInPayout: boolean;
  taxCategory: string;
  /**
   * Set ONLY on a reversal entry — a one-way pointer back to the payout entry
   * it reverses (the original carries no back-pointer). NULL/undefined on every
   * pre-existing row and on all non-reversal lines. Only read by the `payout`
   * branch in computeOwnerRunningBalance / summarizeOwnerPeriod below; income
   * and expense lines never consult it (no reversal path exists for those yet).
   */
  reversalOfEntryId?: string | null;
};

/**
 * Returns the total integer-cent value of a ledger line, folding in SST.
 * Expense "weight" = amount + sstAmount (both are real cash outflows).
 */
const lineCents = (l: OwnerLedgerLine): number =>
  toCents(l.amount, "ownerPeriod") +
  (l.sstAmount ? toCents(l.sstAmount, "ownerPeriod") : 0);

/**
 * Tenant-borne utility income the owner never earns.
 *
 * The gross model (owner-ledger.sync.ts §10b) pairs a tenant carve-out INCOME row
 * with the FULL supplier-bill EXPENSE row, so the two net to the owner's real
 * share. That pairing only exists when a charged UnitUtilityBill backs the charge.
 * On the bills-grid path there is no UnitUtilityBill at all (a hard constraint of
 * that module), so the expense half can never be booked — leaving income with no
 * counterparty, which inflated the payout by the entire tenant utility bill.
 *
 * The sync marks such an unpaired carve-out includeInPayout:false; this predicate
 * is the read side. KAEN collects that money and forwards it to the supplier, so
 * it must not move the payout — while the row itself stays on the statement, which
 * is how the owner sees what the tenant was charged.
 */
const PASS_THROUGH_INCOME_CATEGORIES = new Set<string>(["utility_income", "aircond_income"]);

/**
 * True when an income line is tenant-borne pass-through and must not move the payout.
 *
 * Deliberately narrow on BOTH axes. `includeInPayout` is derived elsewhere as
 * `paidBy === "kaen"` (owner-ledger.service.ts deriveIncludeInPayout), so an
 * admin-entered income row can legitimately carry false without being a
 * pass-through. Restricting the rule to the two utility categories means a false
 * flag on rental/carpark/other income can never silently UNDER-pay a real owner —
 * the failure this guards is far worse than the one it fixes.
 */
export function isPassThroughIncomeLine(l: OwnerLedgerLine): boolean {
  return l.direction === "income" && !l.includeInPayout && PASS_THROUGH_INCOME_CATEGORIES.has(l.category);
}

/**
 * Summarise a slice of owner ledger lines for a period:
 *   - grossRental              : sum of all income lines
 *   - totalExpenses            : sum of ALL expense lines (incl. owner-paid)
 *   - netRentalAfterExpenses   : grossRental − totalExpenses  (financial P&L)
 *   - netPayoutToOwner         : grossRental − payoutExpenses (cash to owner)
 *   - payoutsTotal             : NET cash remittances KAEN → owner for the period —
 *                                gross payout lines MINUS any reversals of those
 *                                payouts (a reversal subtracts back out, it is not
 *                                excluded and not an additional payout). Owner-facing
 *                                surfaces MUST label this "Net payouts" / "Net
 *                                remittances", never "Gross payouts" — it can be
 *                                lower than the sum of visible payout line items
 *                                when a reversal is present.
 *   - byCategory               : expense cents keyed by category (incl. SST)
 *
 * Note: payouts are NOT counted as expenses; they reduce the running balance separately.
 * payoutsTotal here uses the same net-of-reversals convention as the running
 * balance in computeOwnerRunningBalance below, so the close-out identity
 * (broughtForward + netThisPeriod − periodPayouts == carriedForward; see
 * resolveOwnerBalance in owner-ledger.repository.ts) holds exactly.
 */
export function summarizeOwnerPeriod(lines: OwnerLedgerLine[]): {
  grossRental: string;
  totalExpenses: string;
  netRentalAfterExpenses: string;
  netPayoutToOwner: string;
  payoutsTotal: string;
  passThroughIncome: string;
  byCategory: Record<string, string>;
} {
  let grossC = 0;
  let expenseC = 0;
  let payoutExpenseC = 0;
  let payoutsC = 0;
  let passThroughC = 0;
  const byCategory: Record<string, number> = {};

  for (const l of lines) {
    const c = lineCents(l);
    if (l.direction === "income") {
      // Tenant-borne pass-through: reported separately so the statement can still
      // show it, but kept out of grossRental — and therefore out of
      // netPayoutToOwner, which is derived from it.
      if (isPassThroughIncomeLine(l)) passThroughC += c;
      else grossC += c;
    } else if (l.direction === "expense") {
      expenseC += c;
      if (l.includeInPayout) payoutExpenseC += c;
      byCategory[l.category] = (byCategory[l.category] ?? 0) + c;
    } else if (l.direction === "payout") {
      // A reversal restores payable — it subtracts back OUT of payoutsTotal
      // (payoutsTotal is NET of reversals: gross payouts minus reversals), the
      // same convention computeOwnerRunningBalance uses. This keeps the
      // close-out identity exact: broughtForward + netThisPeriod − periodPayouts
      // == carriedForward (periodPayouts = payoutsTotal; see resolveOwnerBalance
      // in owner-ledger.repository.ts). A normal payout (no reversalOfEntryId)
      // is unaffected — still `+= c`, byte-identical to before this change.
      payoutsC += l.reversalOfEntryId ? -c : c;
    }
  }

  return {
    grossRental: centsToString(grossC),
    totalExpenses: centsToString(expenseC),
    netRentalAfterExpenses: centsToString(grossC - expenseC),
    netPayoutToOwner: centsToString(grossC - payoutExpenseC),
    payoutsTotal: centsToString(payoutsC),
    passThroughIncome: centsToString(passThroughC),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, centsToString(v)])
    ),
  };
}

/**
 * Compute the owner's running balance across all lines up to and including
 * the current period (or all-time if no month filtering is applied upstream).
 *
 * Formula:  Σ income − Σ (expense where includeInPayout) − Σ payout
 *
 * Owner-paid-direct expenses (includeInPayout=false) never touch the balance —
 * the owner already bore those costs directly; they appear in P&L only.
 *
 * Negatives are valid: a month where KAEN paid more than income collected will
 * produce a negative carry-forward that auto-rolls to the next period.
 *
 * @param lines All ledger lines for the owner (past + present, pre-filtered by scope)
 * @returns     Integer-cent balance as a 2dp string (may be negative, e.g. "-700.00")
 */
export function computeOwnerRunningBalance(lines: OwnerLedgerLine[]): string {
  let balanceC = 0;

  for (const l of lines) {
    const c = lineCents(l);
    if (l.direction === "income") {
      // Pass-through tenant utility money is not the owner's — it must not raise
      // the balance KAEN remits, or the cash paid would exceed the statement's
      // Total Payout (summarizeOwnerPeriod excludes it from grossRental too).
      if (!isPassThroughIncomeLine(l)) balanceC += c;
    } else if (l.direction === "expense") {
      // Only deduct expenses that KAEN paid on the owner's behalf.
      // Use the STORED includeInPayout flag — owner-overridden statutory expenses
      // (stored false) must NOT be deducted even when the category default is true.
      if (l.includeInPayout) balanceC -= c;
    } else if (l.direction === "payout") {
      // A reversal (reversalOfEntryId set) restores payable — it ADDS back the
      // amount instead of subtracting, so an original remittance (−amount) and
      // its later reversal (+amount) net to exactly zero.
      balanceC += l.reversalOfEntryId ? c : -c;
    }
  }

  return centsToString(balanceC);
}

/**
 * Summarise tax-relevant groupings from expense lines:
 *   - byTaxCategory : total expense cents per tax category
 *   - byCategory    : total expense cents per expense category
 *   - totalExpenses : sum of all expense lines
 *
 * Used by Tasks 7/8 to produce tax summaries for the owner statement.
 */
export function summarizeTax(lines: OwnerLedgerLine[]): {
  byTaxCategory: Record<string, string>;
  byCategory: Record<string, string>;
  totalExpenses: string;
} {
  const byTaxCategory: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let expenseC = 0;

  for (const l of lines) {
    if (l.direction !== "expense") continue;
    const c = lineCents(l);
    expenseC += c;
    byTaxCategory[l.taxCategory] = (byTaxCategory[l.taxCategory] ?? 0) + c;
    byCategory[l.category] = (byCategory[l.category] ?? 0) + c;
  }

  const fmt = (m: Record<string, number>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, centsToString(v)]));

  return {
    byTaxCategory: fmt(byTaxCategory),
    byCategory: fmt(byCategory),
    totalExpenses: centsToString(expenseC),
  };
}
