// Owner-Billing (M6) — net-remittance totals for an owner statement (Task B2).
// Plan: docs/superpowers/plans/2026-06-11-phase2-owner-billing.md (Task B2).
//
// Pure aggregation: collapses the per-line statement (rent collected vs. each
// deduction line — management fee, cleaning, TNB, water, wifi, maintenance,
// insurance, …) into the three numbers an owner statement renders:
//   totalDeductions, netRemittance, sstTotal.
//
// Deterministic integer-cent math. Every value is parsed to cents with the SAME
// `toCents` and rendered with the SAME `centsToString` that B1 / prorateAmount
// use (packages/shared/src/utils/money-cents.ts), so rounding behaviour lives in
// one place and never drifts via parseFloat. Each line already carries its own
// `sstAmount` (SST lives only on the fee line upstream — this function does NOT
// re-derive SST, it just sums what the lines report), so the sum stays exact.
//
// netRemittance may be NEGATIVE when deductions exceed collected rent;
// `centsToString` already preserves the leading "-".

import { centsToString, toCents } from "../utils/money-cents";

export interface OwnerStatementLine {
  /** e.g. "management_fee" | "cleaning" | "tnb" | "water" | "wifi" | "maintenance" | "insurance". */
  chargeType: string;
  /** Decimal string (RM), the line charge before its own SST. */
  amount: string;
  /** Decimal string (RM), the SST charged on this line (0 for non-fee lines). */
  sstAmount: string;
}

export interface OwnerStatementSummaryInput {
  /** Decimal string (RM) — rent collected for the owner this period. */
  collectedRent: string;
  lines: OwnerStatementLine[];
}

export interface OwnerStatementSummary {
  /** Sum over lines of (amount + sstAmount), 2dp string. */
  totalDeductions: string;
  /** collectedRent − totalDeductions, 2dp string (may be negative). */
  netRemittance: string;
  /** Sum of every line's sstAmount, 2dp string. */
  sstTotal: string;
}

export function summarizeStatement(input: OwnerStatementSummaryInput): OwnerStatementSummary {
  const collectedCents = toCents(input.collectedRent, "summarizeStatement");

  let deductionCents = 0;
  let sstCents = 0;
  for (const line of input.lines) {
    const amountCents = toCents(line.amount, "summarizeStatement");
    const lineSstCents = toCents(line.sstAmount, "summarizeStatement");
    deductionCents += amountCents + lineSstCents;
    sstCents += lineSstCents;
  }

  return {
    totalDeductions: centsToString(deductionCents),
    netRemittance: centsToString(collectedCents - deductionCents),
    sstTotal: centsToString(sstCents),
  };
}
