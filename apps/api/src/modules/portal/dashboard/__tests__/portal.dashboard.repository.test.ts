import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  listing: { findMany: vi.fn() },
  charge: { aggregate: vi.fn() },
  payment: { findMany: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { getOwnerDashboardData } from "../portal.dashboard.repository";

beforeEach(() => {
  dbMock.listing.findMany.mockReset().mockResolvedValue([
    { id: "unit-A", occupancyStatus: "occupied", apartment: { propertyId: "P", property: { name: "P" } } },
  ]);
  dbMock.charge.aggregate.mockReset().mockResolvedValue({ _sum: { amount: null } });
  dbMock.payment.findMany.mockReset().mockResolvedValue([]);
});

describe("getOwnerDashboardData", () => {
  it("gates the listing walk on underManagement", async () => {
    await getOwnerDashboardData({ partyId: "owner-1", orgId: "org-1" });
    expect(dbMock.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apartment: expect.objectContaining({ underManagement: true }) }),
      }),
    );
  });

  it("scopes recentPayments by managed unitIds (via tenancies), not ownerPropertyIds", async () => {
    await getOwnerDashboardData({ partyId: "owner-1", orgId: "org-1" });
    const some = dbMock.payment.findMany.mock.calls[0][0].where.party.tenancies.some;
    expect(some.unitId).toEqual({ in: ["unit-A"] });
    expect(some.status).toBe("active");
    expect(some.propertyId).toBeUndefined();
  });

  it("uses the nil-UUID sentinel (valid UUID; '__none__' throws P2007 on the uuid column) for an owner with zero managed units", async () => {
    dbMock.listing.findMany.mockResolvedValue([]);
    await getOwnerDashboardData({ partyId: "owner-1", orgId: "org-1" });
    const some = dbMock.payment.findMany.mock.calls[0][0].where.party.tenancies.some;
    expect(some.unitId).toEqual({ in: ["00000000-0000-0000-0000-000000000000"] });
  });
});
