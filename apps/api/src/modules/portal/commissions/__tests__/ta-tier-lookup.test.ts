import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  taTier: { findFirst: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { taTierLookupService } from "../portal.commissions.service";

const session = {
  orgId: "org-1",
  partyId: "agent-1",
  userId: "user-1",
  userType: "agent",
};

describe("taTierLookupService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the matching tier for a rental within its band", async () => {
    dbMock.taTier.findFirst.mockResolvedValue({
      tier: 1,
      rentalMin: "0.00",
      rentalMax: "2000.00",
      companyMinimum: "216.00",
    });

    const res = await taTierLookupService(session, { monthlyRental: "1800" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        tier: 1,
        rentalMin: "0.00",
        rentalMax: "2000.00",
        companyMinimum: "216.00",
      });
    }

    expect(dbMock.taTier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: session.orgId,
          rentalMin: { lte: "1800" },
        }),
        orderBy: { rentalMin: "desc" },
      }),
    );
  });

  it("handles open-ended top tier (rentalMax null)", async () => {
    dbMock.taTier.findFirst.mockResolvedValue({
      tier: 9,
      rentalMin: "9001.00",
      rentalMax: null,
      companyMinimum: "1080.00",
    });

    const res = await taTierLookupService(session, { monthlyRental: "15000" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.tier).toBe(9);
      expect(res.data.rentalMax).toBeNull();
      expect(res.data.companyMinimum).toBe("1080.00");
    }
  });

  it("returns 404 when no tier exists below the rental", async () => {
    dbMock.taTier.findFirst.mockResolvedValue(null);
    const res = await taTierLookupService(session, { monthlyRental: "500" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});
