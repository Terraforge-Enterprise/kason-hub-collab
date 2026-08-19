/**
 * Under-management gate (R2) for resolveOwnerUnitsForMonth.
 *
 * Un-managed apartments (Apartment.underManagement === false) must NOT appear
 * in an owner's resolved units for a billing month. By DEFAULT (opts absent)
 * this resolver is gated, so the two generation-time callers — owner-statement
 * generation and the cleaning unit picker — exclude un-managed apartments.
 * The third caller, the SST-rate map (resolveMgmtFeeSstRateByUnit), deliberately
 * passes { includeUnmanaged: true } to LIFT this gate: it reproduces the SST%
 * for management_fee lines that were already generated while a unit was managed
 * (post-generation recompute + IVOWN mint), so it must NOT drop a unit that was
 * later flipped un-managed. See owner-billing-sst-rate.ts and the
 * *.include-unmanaged.test.ts suites for that path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = { listing: { findMany: vi.fn() } };

vi.mock("@kason/db", () => ({ getDb: () => dbMock, Prisma: {} }));

import { resolveOwnerUnitsForMonth } from "../owner-billing.repository";

/** Any month — these suites assert the WHERE clause, never the rent math. */
const MONTH = new Date(Date.UTC(2026, 6, 1));

beforeEach(() => {
  dbMock.listing.findMany.mockReset();
  dbMock.listing.findMany.mockResolvedValue([]);
});

describe("resolveOwnerUnitsForMonth — under-management gate (R2)", () => {
  it("filters to underManagement: true apartments", async () => {
    await resolveOwnerUnitsForMonth("org-1", "owner-1", MONTH);

    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerPartyId: "owner-1",
          organizationId: "org-1",
          listingStatus: { not: "archived" },
          apartment: expect.objectContaining({ underManagement: true }),
        }),
      }),
    );
  });
});
