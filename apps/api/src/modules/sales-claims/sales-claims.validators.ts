/**
 * Pure validators for sales-claim business rules.
 *
 * Mirrors the W2b renovation-claims validator (RM 0.01 tolerance, percent vs
 * fixed split semantics) — but operates against the sales-side
 * `computedAmount` (server-derived from purchasePrice + commissionType +
 * commissionValue) rather than RenovationClaim.packagePrice.
 *
 * Lives in its own file so it can be unit-tested without DB or Hono. Both
 * service-side mutations (submit, approve, edit) and tests reuse this.
 */

export type SplitType = "percent" | "fixed";

export interface SplitForValidation {
  splitType: SplitType;
  splitValue: number;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

// Tolerance: ±RM 0.01 absolute. Anything beyond rejects.
const SPLIT_TOLERANCE = 0.01;

/**
 * Returns ok=true when the splits sum exactly to computedAmount (within the
 * RM 0.01 tolerance). Each split contributes:
 *   - splitType=percent → computedAmount × splitValue / 100
 *   - splitType=fixed   → splitValue (already in RM)
 *
 * Empty splits → ok=false (must explicitly cover 100%).
 */
export function validateSalesSplitsHundredPercent(
  splits: SplitForValidation[],
  computedAmount: number,
): ValidationResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: false, error: "At least one split is required" };
  }
  if (
    typeof computedAmount !== "number" ||
    !Number.isFinite(computedAmount) ||
    computedAmount < 0
  ) {
    return { ok: false, error: "Invalid computed amount" };
  }
  let total = 0;
  for (const s of splits) {
    if (
      typeof s.splitValue !== "number" ||
      !Number.isFinite(s.splitValue) ||
      s.splitValue < 0
    ) {
      return { ok: false, error: "Split value must be a non-negative number" };
    }
    if (s.splitType === "percent") {
      total += (computedAmount * s.splitValue) / 100;
    } else if (s.splitType === "fixed") {
      total += s.splitValue;
    } else {
      return { ok: false, error: `Unknown split type: ${String(s.splitType)}` };
    }
  }
  const diff = Math.abs(total - computedAmount);
  if (diff > SPLIT_TOLERANCE) {
    return {
      ok: false,
      error: `Splits must sum to commission amount. Expected RM ${computedAmount.toFixed(2)}, got RM ${total.toFixed(2)}`,
    };
  }
  return { ok: true };
}

/**
 * Server-side commission amount calculator. Source of truth for the
 * computedAmount column on SalesClaim — clients should NOT submit this
 * value directly.
 *
 *   - percent_of_purchase: computedAmount = purchasePrice × commissionValue / 100
 *   - fixed:               computedAmount = commissionValue
 *
 * Rounded to 2 decimal places (cents) to match the schema's Decimal(14,2).
 */
export function computeSalesCommissionAmount(
  commissionType: "percent_of_purchase" | "fixed",
  commissionValue: number,
  purchasePrice: number,
): number {
  if (
    typeof commissionValue !== "number" ||
    !Number.isFinite(commissionValue) ||
    commissionValue < 0
  ) {
    return 0;
  }
  if (
    typeof purchasePrice !== "number" ||
    !Number.isFinite(purchasePrice) ||
    purchasePrice < 0
  ) {
    return 0;
  }
  const raw =
    commissionType === "percent_of_purchase"
      ? (purchasePrice * commissionValue) / 100
      : commissionValue;
  // Round half-up to 2dp.
  return Math.round(raw * 100) / 100;
}
