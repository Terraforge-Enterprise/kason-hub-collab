/**
 * The BILLED amount to display for a ledger row — or null to fall back to the
 * row's own `amount`.
 *
 * Income rows store `amount` = COLLECTED-so-far (0 until the tenant pays); that
 * value is the payout input and is NOT touched here. The billed price lives on
 * the source Charge, so for income rows we surface it for display. Returns null
 * (→ client shows the row's own `amount`) when the row is not income, has no
 * linked charge, or the charge could not be resolved (deleted / out-of-scope).
 *
 * Expense rows already store their full billed amount in `amount`, so they
 * return null and the client falls back to it.
 */
import { centsToString, toCents } from "@kason/shared";
import type { ChargeAdjustmentSums } from "../billing-documents/adjustment-sums";

export function resolveChargedAmount(
  row: { direction: string; sourceChargeId: string | null },
  billedByChargeId: Map<string, string>,
): string | null {
  if (row.direction !== "income") return null;
  if (!row.sourceChargeId) return null;
  return billedByChargeId.get(row.sourceChargeId) ?? null;
}

/**
 * What the counterparty is ACTUALLY billed for a charge, once active credit and
 * debit notes are applied:
 *
 *   billed = max(0, charge.amount + Σ active DN − Σ active CN)
 *
 * ⚠️ MONEY-DISPLAY. This exists because the ledger's two figures were computed on
 * DIFFERENT bases and could not be reconciled by a reader. The row's `amount`
 * (collected) is netted at sync time by `collectedString` +
 * `netAdjustmentsByChargeId`, but the billed figure beside it was read straight off
 * `Charge.amount` with no netting at all. A RM 50 charge with a RM 30 credit note,
 * fully settled, therefore rendered as "billed 50 / collected 20" — indistinguishable
 * on screen from a tenant who simply underpaid by 30, with nothing anywhere to say a
 * credit note existed. Same class of defect as the tenant-portal reads: an owner or
 * tenant money figure must never come from a bare `Charge.amount`.
 *
 * Clamped at 0 on the same reasoning as `collectedString`: a credit note larger than
 * the charge cannot make the billed amount negative — that is the reversal machinery's
 * job, never this figure.
 *
 * Cent-exact; `sums` absent (no active notes on the charge) returns the raw amount
 * re-formatted, so a charge with no adjustments is unchanged.
 */
export function adjustedBilledAmount(rawAmount: string, sums: ChargeAdjustmentSums | undefined): string {
  const cents = toCents(rawAmount, "adjustedBilledAmount");
  if (!sums) return centsToString(cents);
  return centsToString(Math.max(0, cents + sums.debitCents - sums.creditCents));
}
