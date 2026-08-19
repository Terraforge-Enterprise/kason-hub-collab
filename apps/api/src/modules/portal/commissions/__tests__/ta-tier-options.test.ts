import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  taTier: { findMany: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { taTierOptionsService } from "../portal.commissions.service";

const session = {
  orgId: "org-1",
  partyId: "agent-1",
  userId: "user-1",
  userType: "agent",
};

describe("taTierOptionsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all configured tiers as { tier, companyMinimum } sorted by tier asc", async () => {
    dbMock.taTier.findMany.mockResolvedValue([
      { tier: 1, companyMinimum: { toString: () => "216.00" } },
      { tier: 2, companyMinimum: { toString: () => "324.00" } },
      { tier: 3, companyMinimum: { toString: () => "432.00" } },
    ]);

    const res = await taTierOptionsService(session as never);

    expect(res.ok).toBe(true);
    expect(res.data.tiers).toEqual([
      { tier: 1, companyMinimum: "216.00" },
      { tier: 2, companyMinimum: "324.00" },
      { tier: 3, companyMinimum: "432.00" },
    ]);

    expect(dbMock.taTier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: session.orgId },
        orderBy: { tier: "asc" },
        select: { tier: true, companyMinimum: true },
      }),
    );
  });

  it("returns an empty array when no tiers are configured (e.g. fresh UAT org)", async () => {
    dbMock.taTier.findMany.mockResolvedValue([]);
    const res = await taTierOptionsService(session as never);
    expect(res.ok).toBe(true);
    expect(res.data.tiers).toEqual([]);
  });

  it("scopes by organizationId — does not leak other orgs' tiers", async () => {
    dbMock.taTier.findMany.mockResolvedValue([]);
    await taTierOptionsService(session as never);
    const call = dbMock.taTier.findMany.mock.calls[0][0];
    expect(call.where.organizationId).toBe("org-1");
  });
});
