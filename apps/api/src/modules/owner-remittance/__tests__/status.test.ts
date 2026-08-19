/**
 * Task 10 unit tests — derivePeriodRemittanceStatus (owner-remittance.status.ts).
 *
 * Pure function, no DB — runs under the default (mocked-@kason/db) vitest
 * project, no RUN_INTEGRATION needed:
 *   npx vitest run apps/api/src/modules/owner-remittance/__tests__/status.test.ts
 *
 * Behavior inventory (S1-S8; see task-10 report for the full table with
 * RED/GREEN evidence pointers). All 8 rows share ONE RED run (against a
 * deliberately-wrong stub — see owner-remittance.status.ts) and ONE GREEN
 * run (Task-5 precedent for a single cohesive small module — see that
 * task's own report for the identical reasoning).
 *
 * concurrency-idempotency: N/A — pure function, no DB, no shared mutable
 * state; deterministic solely on its two numeric inputs.
 * permission: N/A — pure function, no auth surface (enforced at the
 * route/service layer, covered by owner-account.integration.test.ts).
 */
import { describe, it, expect } from "vitest";
import { derivePeriodRemittanceStatus } from "../owner-remittance.status";

describe("derivePeriodRemittanceStatus — Task 10 (R14)", () => {
  // (S1 happy) allocatedActiveC=0, netPayoutC>0 → AWAITING_REMITTANCE
  it("(S1 awaiting_when_zero_allocated) payable exists, nothing allocated yet — AWAITING_REMITTANCE", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 100_000, allocatedActiveC: 0 })).toBe(
      "AWAITING_REMITTANCE",
    );
  });

  // (S2 happy) 0 < allocatedActiveC < netPayoutC → PARTIALLY_REMITTED
  it("(S2 partially_remitted_mid_range) allocated strictly between 0 and net — PARTIALLY_REMITTED", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 100_000, allocatedActiveC: 40_000 })).toBe(
      "PARTIALLY_REMITTED",
    );
  });

  // (S3 boundary — SABOTAGE TARGET) allocatedActiveC === netPayoutC exactly → FULLY_REMITTED.
  // Flipping the real implementation's `>=` to `>` makes THIS test (and only
  // this one, among the boundary rows) fail — see the sabotage spot-check.
  it("(S3 fully_remitted_at_exact_net) allocated exactly equals net — FULLY_REMITTED", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 100_000, allocatedActiveC: 100_000 })).toBe(
      "FULLY_REMITTED",
    );
  });

  // (S4 boundary) allocatedActiveC === netPayoutC - 1 → PARTIALLY_REMITTED (one cent under FULLY)
  it("(S4 partially_remitted_one_cent_under) allocated one cent short of net — PARTIALLY_REMITTED", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 100_000, allocatedActiveC: 99_999 })).toBe(
      "PARTIALLY_REMITTED",
    );
  });

  // (S5 boundary) netPayoutC === 0, allocatedActiveC === 0 → NO_PAYABLE
  it("(S5 no_payable_zero_net_zero_allocated) nothing payable, nothing allocated — NO_PAYABLE", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 0, allocatedActiveC: 0 })).toBe("NO_PAYABLE");
  });

  // (S6 edge) netPayoutC === 0 but allocatedActiveC > 0 → STILL NO_PAYABLE, regardless of allocated
  // (netPayoutC<=0 is checked FIRST — a zero-payable period is never AWAITING/PARTIALLY/FULLY
  // no matter what the allocation sum says).
  it("(S6 no_payable_zero_net_nonzero_allocated) zero net but nonzero allocated — still NO_PAYABLE (net<=0 wins)", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 0, allocatedActiveC: 50_000 })).toBe(
      "NO_PAYABLE",
    );
  });

  // (S7 error/edge) netPayoutC < 0 → NO_PAYABLE
  it("(S7 no_payable_negative_net) negative net payout — NO_PAYABLE", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: -500, allocatedActiveC: 0 })).toBe(
      "NO_PAYABLE",
    );
  });

  // (S8 edge) allocatedActiveC > netPayoutC (over-allocated, e.g. a post-allocation
  // downward netPayoutC recompute) → still FULLY_REMITTED, not an error.
  it("(S8 fully_remitted_over_allocated) allocated exceeds net — still FULLY_REMITTED, not an error", () => {
    expect(derivePeriodRemittanceStatus({ netPayoutC: 100_000, allocatedActiveC: 120_000 })).toBe(
      "FULLY_REMITTED",
    );
  });
});
