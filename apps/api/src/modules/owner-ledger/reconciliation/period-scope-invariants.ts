/**
 * Combined-scope period invariant — the single source of truth shared by the R9/R10
 * enablement preflight (Condition 7 count) and the R6 frozen-integrity durable finding,
 * so the two can never disagree about what an "orphan" per-unit period is.
 *
 * The closed-period write guard (assertPeriodOpen) and the R5/R6 reconciliation checks
 * are COMBINED-scope only (they read the `apartmentId = null` period). A per-unit period
 * (`apartmentId != null`) frozen WITHOUT its combined sibling frozen for the same
 * owner-month is therefore neither guarded against post-freeze writes nor scanned for
 * drift — an integrity orphan. Reachable via a lazy per-unit portal freeze or a cron
 * combined-freeze failure (both now prevented), plus any legacy/edge row already in that
 * state. READ-ONLY — this module only queries OwnerStatementPeriod.
 */
import { getDb } from "@kason/db";

export interface PerUnitOrphanPeriod {
  id: string;
  ownerPartyId: string;
  apartmentId: string | null;
  periodMonth: Date;
}

/**
 * Find FROZEN per-unit periods (apartmentId != null) that lack a FROZEN combined period
 * (apartmentId = null) for the same (org, owner, periodMonth). Optionally scoped to one
 * owner and/or one month-start so a scoped reconciliation run only examines its own scope.
 *
 * Logic is intentionally identical to the preflight's original Condition-7 body (per-unit
 * findMany, then a combined findFirst per row) so the preflight count and the R6 finding
 * set agree by construction.
 */
export async function findPerUnitFrozenWithoutCombined(
  orgId: string,
  filter?: { ownerPartyId?: string; monthStart?: Date },
): Promise<PerUnitOrphanPeriod[]> {
  const db = getDb();
  const perUnit = await db.ownerStatementPeriod.findMany({
    where: {
      organizationId: orgId,
      status: "frozen",
      apartmentId: { not: null },
      ...(filter?.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
      ...(filter?.monthStart ? { periodMonth: filter.monthStart } : {}),
    },
    select: { id: true, ownerPartyId: true, apartmentId: true, periodMonth: true },
  });

  const orphans: PerUnitOrphanPeriod[] = [];
  for (const p of perUnit) {
    const combined = await db.ownerStatementPeriod.findFirst({
      where: {
        organizationId: orgId,
        status: "frozen",
        apartmentId: null,
        ownerPartyId: p.ownerPartyId,
        periodMonth: p.periodMonth,
      },
      select: { id: true },
    });
    if (!combined) orphans.push(p);
  }
  return orphans;
}
