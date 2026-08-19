import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

const dbMock = {
  agentLevelThreshold: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  party: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  commissionClaim: {
    groupBy: vi.fn(),
  },
  activityLog: {
    create: vi.fn(),
    createMany: vi.fn(),
  },
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbMock)),
};

vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import {
  listLevelThresholdsService,
  updateLevelThresholdService,
  previewLevelThresholdService,
} from "../level-thresholds.service";

const session = { orgId: "o1", userId: "u1", role: "admin" as const, userType: "operator" as const };

const threeRows = [
  { id: "t1", organizationId: "o1", agentLevel: "new_agent",  minCumulativeCommission: new Decimal("0"),     createdAt: new Date(), updatedAt: new Date() },
  { id: "t2", organizationId: "o1", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000"), createdAt: new Date(), updatedAt: new Date() },
  { id: "t3", organizationId: "o1", agentLevel: "leader",     minCumulativeCommission: new Decimal("20000"), createdAt: new Date(), updatedAt: new Date() },
];

describe("listLevelThresholdsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all 3 rows ordered by threshold asc", async () => {
    dbMock.agentLevelThreshold.findMany.mockResolvedValue(threeRows);
    const res = await listLevelThresholdsService(session);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveLength(3);
      expect(res.data.map((r) => r.agentLevel)).toEqual(["new_agent", "pre_leader", "leader"]);
    }
    expect(dbMock.agentLevelThreshold.findMany).toHaveBeenCalledWith({
      where: { organizationId: "o1" },
      orderBy: { minCumulativeCommission: "asc" },
    });
  });

  it("lazy-bootstraps the 3 default rows on every read (idempotent via skipDuplicates)", async () => {
    dbMock.agentLevelThreshold.findMany.mockResolvedValue(threeRows);
    await listLevelThresholdsService(session);
    expect(dbMock.agentLevelThreshold.createMany).toHaveBeenCalledTimes(1);
    expect(dbMock.agentLevelThreshold.createMany).toHaveBeenCalledWith({
      data: [
        { organizationId: "o1", agentLevel: "new_agent",  minCumulativeCommission: "0"     },
        { organizationId: "o1", agentLevel: "pre_leader", minCumulativeCommission: "10000" },
        { organizationId: "o1", agentLevel: "leader",     minCumulativeCommission: "20000" },
      ],
      skipDuplicates: true,
    });
  });
});

describe("updateLevelThresholdService — ladder invariants", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects editing new_agent with 400", async () => {
    const res = await updateLevelThresholdService(session, {
      agentLevel: "new_agent",
      minCumulativeCommission: "500",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("rejects pre_leader >= leader with 400", async () => {
    dbMock.agentLevelThreshold.findFirst.mockResolvedValueOnce({ agentLevel: "leader", minCumulativeCommission: new Decimal("20000") });
    const res = await updateLevelThresholdService(session, {
      agentLevel: "pre_leader",
      minCumulativeCommission: "25000",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("rejects leader <= pre_leader with 400", async () => {
    dbMock.agentLevelThreshold.findFirst.mockResolvedValueOnce({ agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000") });
    const res = await updateLevelThresholdService(session, {
      agentLevel: "leader",
      minCumulativeCommission: "9000",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

describe("updateLevelThresholdService — concurrency + sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 409 when updatedAt mismatches", async () => {
    dbMock.agentLevelThreshold.findFirst
      .mockResolvedValueOnce({ agentLevel: "leader", minCumulativeCommission: new Decimal("20000") }) // invariant check
      .mockResolvedValueOnce({ id: "t2", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000"), updatedAt: new Date() }); // current row
    dbMock.agentLevelThreshold.updateMany.mockResolvedValue({ count: 0 });

    const res = await updateLevelThresholdService(session, {
      agentLevel: "pre_leader",
      minCumulativeCommission: "8000",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("runs the batched sweep and returns bumpedAgentCount", async () => {
    dbMock.agentLevelThreshold.findFirst
      .mockResolvedValueOnce({ agentLevel: "leader", minCumulativeCommission: new Decimal("20000") })
      .mockResolvedValueOnce({ id: "t2", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000"), updatedAt: new Date() })
      .mockResolvedValueOnce({ id: "t2", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("5000"),  updatedAt: new Date() }); // post-write re-read
    dbMock.agentLevelThreshold.updateMany.mockResolvedValue({ count: 1 });

    // Sweep: one bumpable agent.
    dbMock.agentLevelThreshold.findMany.mockResolvedValue([
      { id: "t3", agentLevel: "leader",     minCumulativeCommission: new Decimal("20000") },
      { id: "t2", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("5000") },
      { id: "t1", agentLevel: "new_agent",  minCumulativeCommission: new Decimal("0") },
    ]);
    dbMock.party.findMany.mockResolvedValue([{ id: "a1", agentLevel: "new_agent" }]);
    dbMock.commissionClaim.groupBy.mockResolvedValue([
      { agentPartyId: "a1", _sum: { totalNettPayout: new Decimal("6000") } },
    ]);

    const res = await updateLevelThresholdService(session, {
      agentLevel: "pre_leader",
      minCumulativeCommission: "5000",
      updatedAt: new Date().toISOString(),
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.bumpedAgentCount).toBe(1);
    expect(dbMock.activityLog.create).toHaveBeenCalledTimes(1); // the threshold edit itself
    expect(dbMock.activityLog.createMany).toHaveBeenCalledTimes(1); // the sweep
    expect(dbMock.activityLog.createMany.mock.calls[0][0].data).toHaveLength(1);
  });
});

describe("previewLevelThresholdService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns bumpedAgentCount without writing", async () => {
    dbMock.agentLevelThreshold.findMany.mockResolvedValue([
      { id: "t3", agentLevel: "leader",     minCumulativeCommission: new Decimal("20000") },
      { id: "t2", agentLevel: "pre_leader", minCumulativeCommission: new Decimal("5000") },
      { id: "t1", agentLevel: "new_agent",  minCumulativeCommission: new Decimal("0") },
    ]);
    dbMock.party.findMany.mockResolvedValue([
      { id: "a1", agentLevel: "new_agent" },
      { id: "a2", agentLevel: "new_agent" },
    ]);
    dbMock.commissionClaim.groupBy.mockResolvedValue([
      { agentPartyId: "a1", _sum: { totalNettPayout: new Decimal("6000") } },
      { agentPartyId: "a2", _sum: { totalNettPayout: new Decimal("1000") } },
    ]);

    const res = await previewLevelThresholdService(session, {
      agentLevel: "pre_leader",
      minCumulativeCommission: "5000",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.bumpedAgentCount).toBe(1);

    expect(dbMock.party.updateMany).not.toHaveBeenCalled();
    expect(dbMock.activityLog.create).not.toHaveBeenCalled();
    expect(dbMock.activityLog.createMany).not.toHaveBeenCalled();
  });
});
