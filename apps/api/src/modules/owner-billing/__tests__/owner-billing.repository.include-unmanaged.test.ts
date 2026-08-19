/**
 * `resolveOwnerUnitsForMonth({ includeUnmanaged: true })` — the un-gated escape
 * hatch used by the SST-rate resolver (owner-billing-sst-rate.ts) so that
 * post-generation SST recompute (voidStatementLineService / addAdjustmentLineService
 * / updateStatementLineService) and the IVOWN document mint reproduce the rate for
 * statement lines that were ALREADY generated, even after the apartment is later
 * flipped un-managed.
 *
 * The default/absent-opts path (asserted here too, as a parity guard against
 * owner-billing.repository.under-management.test.ts) MUST stay gated — it backs
 * statement generation (owner-billing.service.ts generateStatementService) and the
 * cleaning unit picker (listOwnerUnitsService), both of which must keep excluding
 * un-managed apartments.
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

describe("resolveOwnerUnitsForMonth — includeUnmanaged opt", () => {
  it("default (opts absent) — where STILL contains the under-management gate (parity guard)", async () => {
    await resolveOwnerUnitsForMonth("org-1", "owner-1", MONTH);

    const where = dbMock.listing.findMany.mock.calls[0]![0].where;
    expect(where).toEqual(
      expect.objectContaining({
        ownerPartyId: "owner-1",
        organizationId: "org-1",
        listingStatus: { not: "archived" },
        apartment: expect.objectContaining({ underManagement: true }),
      }),
    );
  });

  it("{ includeUnmanaged: true } — where has NO underManagement filter, keeps owner/org/status scoping", async () => {
    await resolveOwnerUnitsForMonth("org-1", "owner-1", MONTH, { includeUnmanaged: true });

    const where = dbMock.listing.findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toEqual({
      ownerPartyId: "owner-1",
      organizationId: "org-1",
      listingStatus: { not: "archived" },
    });
    expect(where.apartment).toBeUndefined();
  });
});
