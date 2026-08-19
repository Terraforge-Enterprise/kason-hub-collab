/**
 * resolveMgmtFeeSstRateByUnit (owner-billing-sst-rate.ts) — must resolve units
 * via `resolveOwnerUnitsForMonth(..., { includeUnmanaged: true })`, NOT the
 * gated default. This function feeds the POST-generation SST recompute
 * (voidStatementLineService / addAdjustmentLineService / updateStatementLineService
 * → recomputeTotals) and the IVOWN document mint (billing-documents/issue.service.ts)
 * — both must reproduce the SST% for a management_fee line that was ALREADY
 * generated, regardless of whether the apartment has since been flipped
 * un-managed. If this regresses to the gated default, a flipped-un-managed unit
 * silently drops out of the rate map: recomputeTotals treats it as rate-less (SST
 * recomputes to 0 on an APPROVED statement — voidStatementLineService has no draft
 * guard) and the IVOWN mint throws IVOWN_SST_RATE_UNRESOLVED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../owner-billing.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owner-billing.repository")>();
  return {
    ...actual,
    resolveOwnerUnitsForMonth: vi.fn(async () => []),
    findFeeConfigsForOwner: vi.fn(async () => []),
  };
});

import { findFeeConfigsForOwner, resolveOwnerUnitsForMonth } from "../owner-billing.repository";
import { resolveMgmtFeeSstRateByUnit } from "../owner-billing-sst-rate";

beforeEach(() => {
  vi.mocked(resolveOwnerUnitsForMonth).mockReset();
  vi.mocked(resolveOwnerUnitsForMonth).mockResolvedValue([]);
  vi.mocked(findFeeConfigsForOwner).mockReset();
  vi.mocked(findFeeConfigsForOwner).mockResolvedValue([]);
});

describe("resolveMgmtFeeSstRateByUnit — ungated unit resolution", () => {
  it("calls resolveOwnerUnitsForMonth with { includeUnmanaged: true } (rate path must not be gated)", async () => {
    const periodMonth = new Date("2026-07-01T00:00:00.000Z");
    await resolveMgmtFeeSstRateByUnit("org-1", "owner-1", periodMonth);

    // The statement's own period month must be threaded through: the resolver
    // prorates `rentBaseForMonth` against it, and this rate path must reproduce
    // the SAME units the generate path saw.
    expect(resolveOwnerUnitsForMonth).toHaveBeenCalledWith("org-1", "owner-1", periodMonth, {
      includeUnmanaged: true,
    });
  });
});
