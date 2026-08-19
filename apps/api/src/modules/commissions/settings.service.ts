import { getDb } from "@kason/db";
import type { CommissionSettingsResponse } from "@kason/shared";
import { ensureLevelThresholdsExist } from "./level-thresholds.service";

type Session = {
  orgId: string;
  userId: string;
  role: string;
  userType?: string;
};

type ServiceResult<T> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * Aggregate read of all four commission-settings sections in one call.
 *
 * Returns:
 * - tierMappings        — AgentTierMapping rows (% per claimType × agentLevel)
 * - taTiers             — TaTier rows (rental brackets → company minimum)
 * - roomTypes           — RoomType rows (admin-defined room type taxonomy)
 * - levelThresholds     — AgentLevelThreshold rows (cumulative MYR → level)
 *
 * All four queries are scoped to the caller's organisation and run in
 * parallel. This is a hot read; the write endpoints live in their own
 * services and mutate individual sections.
 */
export async function getCommissionSettingsService(
  session: Session,
): Promise<ServiceResult<CommissionSettingsResponse>> {
  const db = getDb();
  const orgWhere = { organizationId: session.orgId };

  await ensureLevelThresholdsExist(db, session.orgId);

  const [tierMappings, taTiers, roomTypes, levelThresholds] = await Promise.all([
    db.agentTierMapping.findMany({
      where: orgWhere,
      orderBy: [{ claimType: "asc" }, { agentLevel: "asc" }],
    }),
    db.taTier.findMany({
      where: orgWhere,
      orderBy: { rentalMin: "asc" },
    }),
    db.roomType.findMany({
      where: orgWhere,
      orderBy: { sortOrder: "asc" },
    }),
    db.agentLevelThreshold.findMany({
      where: orgWhere,
      orderBy: { minCumulativeCommission: "asc" },
    }),
  ]);

  return {
    ok: true,
    status: 200,
    data: {
      tierMappings: tierMappings.map((tm) => ({
        id: tm.id,
        claimType: tm.claimType as "tenant_portion" | "listing_portion",
        agentLevel: tm.agentLevel as "new_agent" | "pre_leader" | "leader",
        percentage: tm.percentage.toString(),
        isActive: tm.isActive,
        updatedAt: tm.updatedAt?.toISOString(),
      })),
      taTiers: taTiers.map((t) => ({
        id: t.id,
        tier: t.tier,
        rentalMin: t.rentalMin.toString(),
        rentalMax: t.rentalMax?.toString() ?? null,
        companyMinimum: t.companyMinimum.toString(),
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      })),
      roomTypes: roomTypes.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as "WHOLE" | "PARTITION",
        sortOrder: r.sortOrder,
        isActive: r.isActive,
        updatedAt: r.updatedAt?.toISOString(),
      })),
      levelThresholds: levelThresholds.map((lt) => ({
        id: lt.id,
        agentLevel: lt.agentLevel as "new_agent" | "pre_leader" | "leader",
        minCumulativeCommission: lt.minCumulativeCommission.toString(),
        updatedAt: lt.updatedAt?.toISOString(),
      })),
    },
  };
}
