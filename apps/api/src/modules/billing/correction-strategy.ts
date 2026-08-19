import type { CorrectionStrategy } from "@kason/shared";

export type CorrectionEffect = {
  keepsAllocation: boolean;
  requiresRefund: boolean;
  requiresReplacement: boolean;
};

/**
 * Pure mapping of a correction strategy to its allocation/document effect (R1).
 *
 * `_hasCollected` is reserved for a future validated-doc gate — unused today
 * (every branch is static); kept in the signature so all call sites pass it
 * uniformly and Tasks 7/8 can key off it without a signature change.
 *
 * - CREDIT_ADJUSTMENT / DEBIT_ADJUSTMENT keep the payment allocation on the
 *   original charge (the correction is an adjustment document, not a reversal).
 * - CANCEL_AND_REPLACE moves the allocation onto a replacement charge, so it
 *   does NOT keep the allocation and requires replacement lines.
 * - REFUND returns collected money and requires refund details.
 */
export function selectCorrectionEffect(
  strategy: CorrectionStrategy,
  _hasCollected: boolean,
): CorrectionEffect {
  switch (strategy) {
    case "CREDIT_ADJUSTMENT":
      return { keepsAllocation: true, requiresRefund: false, requiresReplacement: false };
    case "DEBIT_ADJUSTMENT":
      return { keepsAllocation: true, requiresRefund: false, requiresReplacement: false };
    case "CANCEL_AND_REPLACE":
      return { keepsAllocation: false, requiresRefund: false, requiresReplacement: true };
    case "REFUND":
      return { keepsAllocation: true, requiresRefund: true, requiresReplacement: false };
  }
}
