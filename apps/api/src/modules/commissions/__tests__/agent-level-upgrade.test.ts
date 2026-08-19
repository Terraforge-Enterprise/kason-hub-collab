import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

// Fresh mock-tx per test so call counts are isolated.
function makeTx() {
  return {
    party: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    commissionClaim: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    agentLevelThreshold: {
      findMany: vi.fn(),
    },
    activityLog: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
  };
}

import { upgradeAgentLevelIfEligible, sweepOrgAgentLevels } from "../agent-level-upgrade";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const thresholdsDesc = [
  { id: "t3", organizationId: ORG, agentLevel: "leader",     minCumulativeCommission: new Decimal("20000") },
  { id: "t2", organizationId: ORG, agentLevel: "pre_leader", minCumulativeCommission: new Decimal("10000") },
  { id: "t1", organizationId: ORG, agentLevel: "new_agent",  minCumulativeCommission: new Decimal("0") },
];

describe("upgradeAgentLevelIfEligible", () => {
  let tx: ReturnType<typeof makeTx>;
  beforeEach(() => {
    tx = makeTx();
    tx.agentLevelThreshold.findMany.mockResolvedValue(thresholdsDesc);
  });

  it("promotes new_agent to pre_leader when cumulative crosses 10k", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "new_agent" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("10500") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT, triggeredByClaimId: "c1" });

    expect(result).toEqual({ bumped: true, from: "new_agent", to: "pre_leader" });
    expect(tx.party.update).toHaveBeenCalledWith({ where: { id: AGENT }, data: { agentLevel: "pre_leader" } });
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1);
  });

  it("jumps two levels — new_agent straight to leader when cumulative crosses 20k", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "new_agent" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("25000") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: true, from: "new_agent", to: "leader" });
    expect(tx.party.update).toHaveBeenCalledWith({ where: { id: AGENT }, data: { agentLevel: "leader" } });
  });

  it("no-op when agent is already at target level", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "pre_leader" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("15000") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: false });
    expect(tx.party.update).not.toHaveBeenCalled();
    expect(tx.activityLog.create).not.toHaveBeenCalled();
  });

  it("no-op when cumulative is below first threshold", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "new_agent" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("9999.99") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: false });
    expect(tx.party.update).not.toHaveBeenCalled();
  });

  it("never demotes — admin-set leader with zero cumulative stays leader", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "leader" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("0") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: false });
    expect(tx.party.update).not.toHaveBeenCalled();
  });

  it("treats null agentLevel as new_agent and promotes when eligible", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: null });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("12000") } });

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: true, from: "new_agent", to: "pre_leader" });
  });

  it("no-op when agent is missing (cross-org mismatch)", async () => {
    tx.party.findFirst.mockResolvedValue(null);

    const result = await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(result).toEqual({ bumped: false });
    expect(tx.commissionClaim.aggregate).not.toHaveBeenCalled();
  });

  it("filters aggregate to currency=MYR and status=paid", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "new_agent" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("0") } });

    await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT });

    expect(tx.commissionClaim.aggregate).toHaveBeenCalledWith({
      where: { organizationId: ORG, agentPartyId: AGENT, status: "paid", currency: "MYR" },
      _sum: { totalNettPayout: true },
    });
  });

  it("logs triggeredByClaimId in ActivityLog metadata", async () => {
    tx.party.findFirst.mockResolvedValue({ id: AGENT, displayName: "A", agentLevel: "new_agent" });
    tx.commissionClaim.aggregate.mockResolvedValue({ _sum: { totalNettPayout: new Decimal("10500") } });

    await upgradeAgentLevelIfEligible(tx as never, { organizationId: ORG, agentPartyId: AGENT, triggeredByClaimId: "c-42" });

    const call = tx.activityLog.create.mock.calls[0][0];
    expect(call.data.metadata).toMatchObject({
      from: "new_agent",
      to: "pre_leader",
      cumulativePaidCommission: "10500.00",
      triggeredByClaimId: "c-42",
    });
    expect(call.data.performedBy).toBeNull();
  });
});

describe("sweepOrgAgentLevels — batched", () => {
  let tx: ReturnType<typeof makeTx>;
  beforeEach(() => {
    tx = makeTx();
    tx.agentLevelThreshold.findMany.mockResolvedValue(thresholdsDesc);
  });

  it("returns [] when the org has no eligible agents", async () => {
    tx.party.findMany.mockResolvedValue([]);
    const bumps = await sweepOrgAgentLevels(tx as never, ORG);
    expect(bumps).toEqual([]);
    expect(tx.commissionClaim.groupBy).not.toHaveBeenCalled();
    expect(tx.party.updateMany).not.toHaveBeenCalled();
    expect(tx.activityLog.createMany).not.toHaveBeenCalled();
  });

  it("promotes bumpable agents and skips those at target", async () => {
    tx.party.findMany.mockResolvedValue([
      { id: "a1", agentLevel: "new_agent" },
      { id: "a2", agentLevel: "new_agent" },
      { id: "a3", agentLevel: "pre_leader" },
    ]);
    tx.commissionClaim.groupBy.mockResolvedValue([
      { agentPartyId: "a1", _sum: { totalNettPayout: new Decimal("12000") } }, // → pre_leader
      { agentPartyId: "a2", _sum: { totalNettPayout: new Decimal("5000") } },  // stays
      { agentPartyId: "a3", _sum: { totalNettPayout: new Decimal("21000") } }, // → leader
    ]);

    const bumps = await sweepOrgAgentLevels(tx as never, ORG);

    expect(bumps).toHaveLength(2);
    expect(bumps.map(b => b.agentId).sort()).toEqual(["a1", "a3"]);

    // Grouped updateMany: one call per target level used.
    expect(tx.party.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.party.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a1"] } }, data: { agentLevel: "pre_leader" } });
    expect(tx.party.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["a3"] } }, data: { agentLevel: "leader"     } });

    // Single createMany call for all activity logs.
    expect(tx.activityLog.createMany).toHaveBeenCalledTimes(1);
    expect(tx.activityLog.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it("excludes blacklisted and leader agents from the party.findMany filter", async () => {
    tx.party.findMany.mockResolvedValue([]);
    await sweepOrgAgentLevels(tx as never, ORG);

    expect(tx.party.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        partyType: "agent",
        isBlacklisted: false,
        agentLevel: { not: "leader" },
      },
      select: { id: true, agentLevel: true },
    });
  });

  it("filters aggregate to currency=MYR and status=paid", async () => {
    tx.party.findMany.mockResolvedValue([{ id: "a1", agentLevel: "new_agent" }]);
    tx.commissionClaim.groupBy.mockResolvedValue([]);

    await sweepOrgAgentLevels(tx as never, ORG);

    expect(tx.commissionClaim.groupBy).toHaveBeenCalledWith({
      by: ["agentPartyId"],
      where: {
        organizationId: ORG,
        status: "paid",
        currency: "MYR",
        agentPartyId: { in: ["a1"] },
      },
      _sum: { totalNettPayout: true },
    });
  });

  // Query-count regression guard (spec §5.2).
  it("runs a fixed number of queries regardless of agent count", async () => {
    const agents = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, agentLevel: "new_agent" }));
    const sums = agents.map((a) => ({ agentPartyId: a.id, _sum: { totalNettPayout: new Decimal("12000") } }));
    tx.party.findMany.mockResolvedValue(agents);
    tx.commissionClaim.groupBy.mockResolvedValue(sums);

    await sweepOrgAgentLevels(tx as never, ORG);

    expect(tx.agentLevelThreshold.findMany).toHaveBeenCalledTimes(1);
    expect(tx.party.findMany).toHaveBeenCalledTimes(1);
    expect(tx.commissionClaim.groupBy).toHaveBeenCalledTimes(1);
    // At most one updateMany per distinct target level actually used (here: just pre_leader).
    expect(tx.party.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.activityLog.createMany).toHaveBeenCalledTimes(1);

    // Forbidden N+1 primitives:
    expect(tx.party.findFirst).not.toHaveBeenCalled();
    expect(tx.party.update).not.toHaveBeenCalled();
    expect(tx.commissionClaim.aggregate).not.toHaveBeenCalled();
    expect(tx.activityLog.create).not.toHaveBeenCalled();
  });
});
