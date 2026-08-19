import { getDb } from "@kason/db";
import { recalculateRenovationProgressStatus } from "../../../lib/recalculate-renovation-progress-status";
import type { FlipStageInput } from "./portal.renovation-progress.validation";

export type RenovationProgressCtx = { orgId: string; agentPartyId: string; actorUserId: string };

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

async function checkOwnership(tx: any, progressId: string, ctx: RenovationProgressCtx) {
  const progress = await tx.renovationProgress.findFirst({
    where: { id: progressId, organizationId: ctx.orgId, archivedAt: null },
    select: { id: true, salesUnitId: true, organizationId: true },
  });
  if (!progress) {
    return {
      ok: false as const,
      status: 404 as const,
      error: { code: "progress_not_found", message: "Renovation progress not found." },
    };
  }
  const unit = await tx.salesUnit.findFirst({
    where: { id: progress.salesUnitId, organizationId: ctx.orgId, agentPartyId: ctx.agentPartyId },
    select: { id: true, agentPartyId: true },
  });
  if (!unit) {
    return {
      ok: false as const,
      status: 404 as const,
      error: { code: "unit_not_owned", message: "Sales unit not owned by current agent." },
    };
  }
  return { ok: true as const, data: { progress, unit } };
}

export async function flipStageStatusService(
  progressId: string,
  stageProgressId: string,
  input: FlipStageInput,
  ctx: RenovationProgressCtx,
): Promise<Result<{ id: string; status: string; progressStatus: string }>> {
  const db = getDb();
  return db.$transaction(async (tx: any) => {
    const ownership = await checkOwnership(tx, progressId, ctx);
    if (!ownership.ok) return ownership;

    const stage = await tx.renovationStageProgress.findFirst({
      where: { id: stageProgressId, progressId },
      select: { id: true, status: true, startedAt: true, completedAt: true },
    });
    if (!stage) {
      return {
        ok: false as const,
        status: 404 as const,
        error: { code: "stage_not_found", message: "Stage progress row not found." },
      };
    }

    const now = new Date();
    const data: Record<string, unknown> = { status: input.status };
    if (input.note !== undefined) data.note = input.note;

    // Manage timestamps based on transition direction.
    if (input.status === "pending") {
      data.startedAt = null;
      data.completedAt = null;
    } else if (input.status === "in_progress") {
      data.startedAt = stage.startedAt ?? now;
      data.completedAt = null;
    } else if (input.status === "completed") {
      data.startedAt = stage.startedAt ?? now;
      data.completedAt = now;
    }

    const updated = await tx.renovationStageProgress.update({
      where: { id: stageProgressId },
      data,
    });

    const progressStatus = await recalculateRenovationProgressStatus(tx, progressId);

    return { ok: true as const, data: { id: updated.id, status: updated.status, progressStatus } };
  });
}

export async function markRenovationCompleteService(
  progressId: string,
  ctx: RenovationProgressCtx,
): Promise<Result<{ id: string; status: string }>> {
  const db = getDb();
  return db.$transaction(async (tx: any) => {
    const ownership = await checkOwnership(tx, progressId, ctx);
    if (!ownership.ok) return ownership;

    const stages = await tx.renovationStageProgress.findMany({
      where: { progressId },
      select: { status: true },
    });
    const allDone = stages.length > 0 && stages.every((s: any) => s.status === "completed");
    if (!allDone) {
      return {
        ok: false as const,
        status: 400 as const,
        error: {
          code: "stages_incomplete",
          message: "All stages must be completed before marking the renovation complete.",
        },
      };
    }

    const updated = await tx.renovationProgress.update({
      where: { id: progressId },
      data: {
        status: "completed",
        actualCompletion: new Date(),
        updatedById: ctx.actorUserId,
      },
    });
    return { ok: true as const, data: { id: updated.id, status: updated.status } };
  });
}
