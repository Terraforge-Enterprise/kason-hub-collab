/**
 * Portal sales-unit detail service.
 *
 * Owns the rich read shape consumed by the agent's pipeline-page Unit
 * Detail drawer (Plan 2 / Task 11). Joins project, ownerParty, and
 * renovationProgress (with stages) so the drawer can render flip controls
 * + mark-complete in a single round-trip.
 *
 * Kept separate from `getSalesUnitByIdService` (admin) to keep the admin
 * row shape narrow and avoid widening `SalesUnitRow`.
 */
import { getDb } from "@kason/db";

export type PortalSalesUnitDetailCtx = {
  orgId: string;
  agentPartyId: string;
};

export type PortalSalesUnitDetailStage = {
  stageProgressId: string;
  stageKey: string;
  stageLabel: string;
  sortOrder: number;
  status: "pending" | "in_progress" | "completed";
};

export type PortalSalesUnitDetail = {
  id: string;
  unitNumber: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  bedrooms: number;
  bathrooms: number;
  sourcingApproved: boolean;
  project: { id: string; name: string };
  ownerParty: { id: string; displayName: string };
  renovationProgress: null | {
    id: string;
    status: "not_started" | "on_going" | "completed";
    startDate: string | null;
    expectedCompletion: string | null;
    actualCompletion: string | null;
    stages: PortalSalesUnitDetailStage[];
  };
};

type Result<T> =
  | { ok: true; status: 200; data: T }
  | { ok: false; status: 404; error: string };

export async function getPortalSalesUnitDetailService(
  ctx: PortalSalesUnitDetailCtx,
  unitId: string,
): Promise<Result<PortalSalesUnitDetail>> {
  const db = getDb();
  const row = await db.salesUnit.findFirst({
    where: {
      id: unitId,
      organizationId: ctx.orgId,
      agentPartyId: ctx.agentPartyId,
    },
    select: {
      id: true,
      unitNumber: true,
      salesDate: true,
      purpose: true,
      bedrooms: true,
      bathrooms: true,
      sourcingApproved: true,
      project: { select: { id: true, name: true } },
      ownerParty: { select: { id: true, displayName: true } },
      renovationProgress: {
        select: {
          id: true,
          status: true,
          startDate: true,
          expectedCompletion: true,
          actualCompletion: true,
          stageProgress: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true,
              stage: {
                select: { id: true, key: true, label: true, sortOrder: true },
              },
            },
          },
        },
      },
    },
  });

  if (!row) {
    return { ok: false, status: 404, error: "Sales unit not found" };
  }

  // `purpose` and `status` are stored as `String` in the Prisma schema (with
  // a literal-comment contract); narrow at this boundary so the typed client
  // shape lines up with the public PortalSalesUnitDetail.
  const renovationProgress = row.renovationProgress
    ? {
        id: row.renovationProgress.id,
        status: row.renovationProgress.status as
          | "not_started"
          | "on_going"
          | "completed",
        startDate: toIso(row.renovationProgress.startDate),
        expectedCompletion: toIso(row.renovationProgress.expectedCompletion),
        actualCompletion: toIso(row.renovationProgress.actualCompletion),
        stages: row.renovationProgress.stageProgress
          .slice()
          .sort((a, b) => a.stage.sortOrder - b.stage.sortOrder)
          .map((sp) => ({
            stageProgressId: sp.id,
            stageKey: sp.stage.key,
            stageLabel: sp.stage.label,
            sortOrder: sp.stage.sortOrder,
            status: sp.status as "pending" | "in_progress" | "completed",
          })),
      }
    : null;

  return {
    ok: true,
    status: 200,
    data: {
      id: row.id,
      unitNumber: row.unitNumber,
      salesDate: toIso(row.salesDate)!,
      purpose: row.purpose as "rent" | "own_stay",
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      sourcingApproved: row.sourcingApproved,
      project: row.project,
      ownerParty: row.ownerParty,
      renovationProgress,
    },
  };
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : d;
}
