import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  agentTierMapping: { findMany: vi.fn() },
  taTier: { findMany: vi.fn() },
  roomType: { findMany: vi.fn() },
  agentLevelThreshold: {
    findMany: vi.fn(),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { getCommissionSettingsService } from "../settings.service";

const session = {
  orgId: "org-1",
  userId: "user-1",
  role: "manager" as const,
  userType: "operator" as const,
};

describe("getCommissionSettingsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all four sections in one payload scoped to orgId", async () => {
    dbMock.agentTierMapping.findMany.mockResolvedValue([
      {
        id: "tm-1",
        claimType: "tenant_portion",
        agentLevel: "new_agent",
        percentage: "40.00",
        isActive: true,
        updatedAt: new Date(),
      },
    ]);
    dbMock.taTier.findMany.mockResolvedValue([
      {
        id: "tt-1",
        tier: 1,
        rentalMin: "0.00",
        companyMinimum: "216.00",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    dbMock.roomType.findMany.mockResolvedValue([
      { id: "rt-1", name: "Master", kind: "PARTITION", sortOrder: 1, isActive: true, updatedAt: new Date() },
    ]);
    dbMock.agentLevelThreshold.findMany.mockResolvedValue([
      { id: "lt-1", agentLevel: "pre_leader", minCumulativeCommission: "10000.00", updatedAt: new Date() },
    ]);

    const res = await getCommissionSettingsService(session);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.tierMappings).toHaveLength(1);
      expect(res.data.taTiers).toHaveLength(1);
      expect(res.data.roomTypes).toHaveLength(1);
      expect(res.data.levelThresholds).toHaveLength(1);
    }

    for (const fn of [
      dbMock.agentTierMapping.findMany,
      dbMock.taTier.findMany,
      dbMock.roomType.findMany,
      dbMock.agentLevelThreshold.findMany,
    ]) {
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: session.orgId } }),
      );
    }
  });

  it("returns kind on each RoomType row", async () => {
    dbMock.agentTierMapping.findMany.mockResolvedValue([]);
    dbMock.taTier.findMany.mockResolvedValue([]);
    dbMock.agentLevelThreshold.findMany.mockResolvedValue([]);
    dbMock.roomType.findMany.mockResolvedValue([
      { id: "rt-1", name: "Studio", kind: "WHOLE", sortOrder: 0, isActive: true, updatedAt: new Date() },
      { id: "rt-2", name: "Master", kind: "PARTITION", sortOrder: 1, isActive: true, updatedAt: new Date() },
    ]);

    const res = await getCommissionSettingsService(session);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const studio = res.data.roomTypes.find((r) => r.name === "Studio");
    expect(studio?.kind).toBe("WHOLE");
    const master = res.data.roomTypes.find((r) => r.name === "Master");
    expect(master?.kind).toBe("PARTITION");
  });
});
