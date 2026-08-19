// Phase-2 owner remittance — R14: per-period REMITTANCE status, a derived
// axis DISTINCT from BillingDocument.settlementStatus (an invoice's PAYMENT
// status — already exists, unchanged, NEVER re-derived here). Pure integer-
// cents math; no DB, no imports, no side effects (Task 10).
//
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md
// (Task 10). Spec: docs/superpowers/specs/2026-07-20-rental-reclassification-owner-payable-completion-design.md
// (R14).
//
// A period's remittance status answers "has KAEN paid the OWNER out for this
// period's net payout yet?" — completely orthogonal to whether the TENANT has
// paid their own invoice (that's settlementStatus, a different table/column
// entirely). A July rent invoice can be settlementStatus=PAID (tenant paid in
// full) while its OwnerStatementPeriod is still AWAITING_REMITTANCE (KAEN
// hasn't remitted the owner) — both true simultaneously. Callers MUST NOT
// merge, blend, or let one influence the other's derivation.

export type PeriodRemittanceStatus =
  | "NO_PAYABLE"
  | "AWAITING_REMITTANCE"
  | "PARTIALLY_REMITTED"
  | "FULLY_REMITTED";

export interface DerivePeriodRemittanceStatusArgs {
  /** OwnerStatementPeriod.netPayoutC — the period's total payable to the owner, integer cents. */
  netPayoutC: number;
  /**
   * Σ ACTIVE remittance allocations against this period, integer cents. The
   * CALLER computes this as `netPayoutC − periodRemainingPayableC(...)`
   * (owner-remittance.repository.ts — the Task-5 rail; "active" = parent
   * payout entry not reversed/voided). This function never queries the DB
   * and never re-derives allocation activity itself.
   */
  allocatedActiveC: number;
}

/**
 * Four-branch derivation, checked in this exact order (each branch's guard
 * is mutually exclusive with the ones above it):
 *   1. `netPayoutC<=0` → NO_PAYABLE, UNCONDITIONALLY — a period with nothing
 *      payable is never AWAITING/PARTIALLY/FULLY, no matter what the
 *      allocation sum says (S6 pins this: net=0, allocated>0 is still
 *      NO_PAYABLE, not a divide-by-zero-flavored edge case).
 *   2. `allocatedActiveC===0` → AWAITING_REMITTANCE — payable exists, KAEN
 *      hasn't remitted the owner anything yet.
 *   3. `allocatedActiveC>=netPayoutC` → FULLY_REMITTED — the `>=`, not `>`,
 *      is load-bearing: an EXACT match (allocated===net) must count as
 *      fully remitted (S3), and an allocation that exceeds net (S8 — e.g.
 *      after a downward netPayoutC recompute post-allocation) is still
 *      "fully" rather than an error state this pure function has no
 *      business rejecting.
 *   4. Otherwise (`0<allocatedActiveC<netPayoutC`) → PARTIALLY_REMITTED.
 */
export function derivePeriodRemittanceStatus({
  netPayoutC,
  allocatedActiveC,
}: DerivePeriodRemittanceStatusArgs): PeriodRemittanceStatus {
  if (netPayoutC <= 0) return "NO_PAYABLE";
  if (allocatedActiveC === 0) return "AWAITING_REMITTANCE";
  if (allocatedActiveC >= netPayoutC) return "FULLY_REMITTED";
  return "PARTIALLY_REMITTED";
}
