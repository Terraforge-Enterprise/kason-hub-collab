import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";

/**
 * Level rank used for one-way upgrade comparison. Do NOT add new levels here
 * without also updating the AgentLevelThreshold seed (packages/db/prisma/seed.ts)
 * and the agentLevelEnum in packages/shared/src/schemas/level-thresholds.ts.
 */
export const LEVEL_RANK: Record<string, number> = {
  new_agent: 0,
  pre_leader: 1,
  leader: 2,
};

export type PrismaTxn = Prisma.TransactionClient;

export interface UpgradeResult {
  bumped: boolean;
  from?: string;
  to?: string;
}

/**
 * Evaluate a single agent against the org's thresholds and promote them
 * if their cumulative paid commission (MYR) qualifies them for a higher
 * level. One-way — never demotes.
 *
 * Called inside payClaimService's transaction (one agent per call).
 * Do NOT call in a loop across all agents — use sweepOrgAgentLevels for
 * batched org-wide evaluation (Task 4).
 */
export async function upgradeAgentLevelIfEligible(
  tx: PrismaTxn,
  params: {
    organizationId: string;
    agentPartyId: string;
    triggeredByClaimId?: string;
  },
): Promise<UpgradeResult> {
  const { organizationId, agentPartyId, triggeredByClaimId } = params;

  const agent = await tx.party.findFirst({
    where: { id: agentPartyId, organizationId },
    select: { id: true, displayName: true, agentLevel: true },
  });
  if (!agent) return { bumped: false };

  const currentLevel = agent.agentLevel ?? "new_agent";

  // Cumulative paid commission — MYR only (see spec §1.6).
  const agg = await tx.commissionClaim.aggregate({
    where: { organizationId, agentPartyId, status: "paid", currency: "MYR" },
    _sum: { totalNettPayout: true },
  });
  const cumulative = new Decimal(agg._sum.totalNettPayout?.toString() ?? "0");

  const thresholds = await tx.agentLevelThreshold.findMany({
    where: { organizationId },
    orderBy: { minCumulativeCommission: "desc" },
  });
  const targetLevel =
    thresholds.find((t) => cumulative.gte(t.minCumulativeCommission.toString()))?.agentLevel ??
    "new_agent";

  if ((LEVEL_RANK[targetLevel] ?? 0) <= (LEVEL_RANK[currentLevel] ?? 0)) {
    return { bumped: false };
  }

  await tx.party.update({
    where: { id: agent.id },
    data: { agentLevel: targetLevel },
  });

  await tx.activityLog.create({
    data: {
      organizationId,
      entityType: "party",
      entityId: agent.id,
      action: "agent_level_auto_upgraded",
      description: `Agent ${agent.displayName} auto-upgraded to ${targetLevel}`,
      performedBy: null, // system action — ActivityLog.performedBy is nullable
      metadata: {
        from: currentLevel,
        to: targetLevel,
        cumulativePaidCommission: cumulative.toFixed(2),
        triggeredByClaimId: triggeredByClaimId ?? null,
      },
    },
  });

  return { bumped: true, from: currentLevel, to: targetLevel };
}

export interface AgentBump {
  agentId: string;
  from: string;
  to: string;
  cumulative: string;
}

/**
 * Batched org-wide agent-level sweep. Fixed query count (3 reads + at
 * most 2 updateMany + 1 createMany) regardless of how many agents the
 * org has. See spec §2.2.1.
 *
 * Designed to be called inside updateLevelThresholdService's transaction.
 * Skips blacklisted agents and agents already at the top level.
 */
export async function sweepOrgAgentLevels(
  tx: PrismaTxn,
  organizationId: string,
): Promise<AgentBump[]> {
  const thresholds = await tx.agentLevelThreshold.findMany({
    where: { organizationId },
    orderBy: { minCumulativeCommission: "desc" },
  });

  const agents = await tx.party.findMany({
    where: {
      organizationId,
      partyType: "agent",
      isBlacklisted: false,
      agentLevel: { not: "leader" },
    },
    select: { id: true, agentLevel: true },
  });
  if (agents.length === 0) return [];

  const sums = await tx.commissionClaim.groupBy({
    by: ["agentPartyId"],
    where: {
      organizationId,
      status: "paid",
      currency: "MYR",
      agentPartyId: { in: agents.map((a) => a.id) },
    },
    _sum: { totalNettPayout: true },
  });
  const cumulativeByAgent = new Map<string, Decimal>(
    sums.map((s) => [s.agentPartyId, new Decimal(s._sum.totalNettPayout?.toString() ?? "0")]),
  );

  const bumps: AgentBump[] = [];
  for (const agent of agents) {
    const current = agent.agentLevel ?? "new_agent";
    const cumulative = cumulativeByAgent.get(agent.id) ?? new Decimal(0);
    const target =
      thresholds.find((t) => cumulative.gte(t.minCumulativeCommission.toString()))?.agentLevel ??
      "new_agent";
    if ((LEVEL_RANK[target] ?? 0) > (LEVEL_RANK[current] ?? 0)) {
      bumps.push({
        agentId: agent.id,
        from: current,
        to: target,
        cumulative: cumulative.toFixed(2),
      });
    }
  }
  if (bumps.length === 0) return [];

  // Grouped updateMany — at most 2 calls (pre_leader, leader).
  const idsByTarget = new Map<string, string[]>();
  for (const b of bumps) {
    idsByTarget.set(b.to, [...(idsByTarget.get(b.to) ?? []), b.agentId]);
  }
  for (const [targetLevel, ids] of idsByTarget) {
    await tx.party.updateMany({
      where: { id: { in: ids } },
      data: { agentLevel: targetLevel },
    });
  }

  await tx.activityLog.createMany({
    data: bumps.map((b) => ({
      organizationId,
      entityType: "party",
      entityId: b.agentId,
      action: "agent_level_auto_upgraded",
      description: `Agent auto-upgraded to ${b.to}`,
      performedBy: null,
      metadata: {
        from: b.from,
        to: b.to,
        cumulativePaidCommission: b.cumulative,
        triggeredBy: "threshold_edit",
      },
    })),
  });

  return bumps;
}
