import { getDb } from "@kason/db";
import Decimal from "decimal.js";
import { sweepOrgAgentLevels } from "./agent-level-upgrade";
import type { AgentLevel, UpdateLevelThresholdInput, LevelThresholdPreviewInput } from "@kason/shared";

type Session = {
  orgId: string;
  userId: string;
  role: "admin" | "manager";
  userType: "operator";
};

type ServiceResult<T> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface LevelThresholdRow {
  id: string;
  agentLevel: AgentLevel;
  minCumulativeCommission: string;
  createdAt: Date;
  updatedAt: Date;
}

// Default thresholds seeded for every org. Originally only the `kaen-demo` and
// `kaen-uat` seed orgs had these rows — orgs created any other way had none,
// which made the Auto-Promotion settings UI dead-end on "Not configured".
const DEFAULT_LEVEL_THRESHOLDS: ReadonlyArray<{ agentLevel: AgentLevel; minCumulativeCommission: string }> = [
  { agentLevel: "new_agent",  minCumulativeCommission: "0"     },
  { agentLevel: "pre_leader", minCumulativeCommission: "10000" },
  { agentLevel: "leader",     minCumulativeCommission: "20000" },
];

/**
 * Idempotent bootstrap — make sure every org has all 3 expected rows. Safe to
 * call on every read; the unique index on (organizationId, agentLevel) plus
 * skipDuplicates guarantees no double-insert.
 */
export async function ensureLevelThresholdsExist(
  db: ReturnType<typeof getDb>,
  orgId: string,
): Promise<void> {
  await db.agentLevelThreshold.createMany({
    data: DEFAULT_LEVEL_THRESHOLDS.map((d) => ({
      organizationId: orgId,
      agentLevel: d.agentLevel,
      minCumulativeCommission: d.minCumulativeCommission,
    })),
    skipDuplicates: true,
  });
}

export async function listLevelThresholdsService(
  session: Session,
): Promise<ServiceResult<LevelThresholdRow[]>> {
  const db = getDb();
  await ensureLevelThresholdsExist(db, session.orgId);
  const rows = await db.agentLevelThreshold.findMany({
    where: { organizationId: session.orgId },
    orderBy: { minCumulativeCommission: "asc" },
  });
  return {
    ok: true,
    status: 200,
    data: rows.map((r) => ({
      id: r.id,
      agentLevel: r.agentLevel as AgentLevel,
      minCumulativeCommission: r.minCumulativeCommission.toString(),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  };
}

async function validateLadder(
  db: ReturnType<typeof getDb>,
  session: Session,
  input: { agentLevel: AgentLevel; minCumulativeCommission: string },
): Promise<ServiceResult<null>> {
  if (input.agentLevel === "new_agent") {
    return {
      ok: false,
      status: 400,
      error: "The New Agent threshold is the starting level and cannot be edited.",
    };
  }

  const proposed = new Decimal(input.minCumulativeCommission);
  if (proposed.lt("0.01")) {
    return {
      ok: false,
      status: 400,
      error: "Threshold must be at least 0.01 for an editable level.",
    };
  }

  if (input.agentLevel === "pre_leader") {
    const leader = await db.agentLevelThreshold.findFirst({
      where: { organizationId: session.orgId, agentLevel: "leader" },
    });
    if (leader && proposed.gte(leader.minCumulativeCommission.toString())) {
      return {
        ok: false,
        status: 400,
        error: "Pre-Leader threshold must be less than Leader threshold.",
      };
    }
  }
  if (input.agentLevel === "leader") {
    const preLeader = await db.agentLevelThreshold.findFirst({
      where: { organizationId: session.orgId, agentLevel: "pre_leader" },
    });
    if (preLeader && proposed.lte(preLeader.minCumulativeCommission.toString())) {
      return {
        ok: false,
        status: 400,
        error: "Leader threshold must be greater than Pre-Leader threshold.",
      };
    }
  }

  return { ok: true, status: 200, data: null };
}

export async function updateLevelThresholdService(
  session: Session,
  input: UpdateLevelThresholdInput,
): Promise<ServiceResult<{ id: string; updatedAt: Date; bumpedAgentCount: number }>> {
  const db = getDb();

  const laddered = await validateLadder(db, session, {
    agentLevel: input.agentLevel,
    minCumulativeCommission: input.minCumulativeCommission,
  });
  if (!laddered.ok) return laddered as ServiceResult<never>;

  return db.$transaction(async (tx) => {
    // Snapshot current row so we can log before/after.
    const current = await tx.agentLevelThreshold.findFirst({
      where: { organizationId: session.orgId, agentLevel: input.agentLevel },
    });
    if (!current) {
      return { ok: false as const, status: 404 as const, error: "Threshold not found." };
    }

    // Optimistic-concurrency update — 0 rows means someone else moved on.
    const write = await tx.agentLevelThreshold.updateMany({
      where: {
        organizationId: session.orgId,
        agentLevel: input.agentLevel,
        updatedAt: new Date(input.updatedAt),
      },
      data: { minCumulativeCommission: input.minCumulativeCommission },
    });
    if (write.count === 0) {
      return {
        ok: false as const,
        status: 409 as const,
        error: "Threshold was modified by another admin. Please reload.",
      };
    }

    // Re-read to get the DB-stamped updatedAt — clients echo it back on
    // the next save, so we must return the real value or they get a 409.
    const updated = await tx.agentLevelThreshold.findFirst({
      where: { organizationId: session.orgId, agentLevel: input.agentLevel },
    });

    // Batched sweep.
    const bumps = await sweepOrgAgentLevels(tx, session.orgId);

    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "agent_level_threshold",
        entityId: current.id,
        action: "updated",
        description: `Level threshold ${input.agentLevel} updated`,
        performedBy: session.userId,
        metadata: {
          agentLevel: input.agentLevel,
          before: current.minCumulativeCommission.toString(),
          after: new Decimal(input.minCumulativeCommission).toFixed(2),
          bumpedAgentCount: bumps.length,
        },
      },
    });

    return {
      ok: true as const,
      status: 200 as const,
      data: {
        id: updated!.id,
        updatedAt: updated!.updatedAt,
        bumpedAgentCount: bumps.length,
      },
    };
  });
}

/**
 * Read-only preview — what would the batched sweep do if this threshold
 * value were applied right now? No writes, no ActivityLog.
 *
 * NOTE: this duplicates the core of sweepOrgAgentLevels because the two
 * have different semantics: sweep applies the CURRENT DB thresholds,
 * while preview simulates a HYPOTHETICAL threshold swap in memory
 * without persisting. Refactoring them to share a pure computeBumps()
 * function is a valid follow-up; for v1 the duplication is small and
 * intentional.
 */
export async function previewLevelThresholdService(
  session: Session,
  input: LevelThresholdPreviewInput,
): Promise<ServiceResult<{ bumpedAgentCount: number }>> {
  const db = getDb();

  const actual = await db.agentLevelThreshold.findMany({
    where: { organizationId: session.orgId },
    orderBy: { minCumulativeCommission: "desc" },
  });
  const simulated = actual.map((t) =>
    t.agentLevel === input.agentLevel
      ? { ...t, minCumulativeCommission: new Decimal(input.minCumulativeCommission) }
      : t,
  );
  simulated.sort((a, b) =>
    new Decimal(b.minCumulativeCommission.toString())
      .comparedTo(new Decimal(a.minCumulativeCommission.toString())),
  );

  const agents = await db.party.findMany({
    where: {
      organizationId: session.orgId,
      partyType: "agent",
      isBlacklisted: false,
      agentLevel: { not: "leader" },
    },
    select: { id: true, agentLevel: true },
  });
  if (agents.length === 0) return { ok: true, status: 200, data: { bumpedAgentCount: 0 } };

  const sums = await db.commissionClaim.groupBy({
    by: ["agentPartyId"],
    where: {
      organizationId: session.orgId,
      status: "paid",
      currency: "MYR",
      agentPartyId: { in: agents.map((a) => a.id) },
    },
    _sum: { totalNettPayout: true },
  });
  const cumulativeByAgent = new Map<string, Decimal>(
    sums.map((s) => [s.agentPartyId, new Decimal(s._sum.totalNettPayout?.toString() ?? "0")]),
  );

  const LEVEL_RANK: Record<string, number> = { new_agent: 0, pre_leader: 1, leader: 2 };

  let count = 0;
  for (const agent of agents) {
    const current = agent.agentLevel ?? "new_agent";
    const cumulative = cumulativeByAgent.get(agent.id) ?? new Decimal(0);
    const target =
      simulated.find((t) => cumulative.gte(t.minCumulativeCommission.toString()))?.agentLevel ??
      "new_agent";
    if ((LEVEL_RANK[target] ?? 0) > (LEVEL_RANK[current] ?? 0)) count += 1;
  }

  return { ok: true, status: 200, data: { bumpedAgentCount: count } };
}
