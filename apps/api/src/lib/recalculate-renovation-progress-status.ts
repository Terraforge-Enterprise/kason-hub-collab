import type { Prisma } from "@kason/db";

export type RenovationProgressStatus = "not_started" | "on_going" | "completed";

/**
 * Reads all RenovationStageProgress rows for a given progressId, derives
 * the parent RenovationProgress.status, writes it. Single source of
 * truth for the auto-flip rule.
 *
 * Rules:
 *   - all stages completed   -> "completed"
 *   - any stage in_progress  -> "on_going"
 *   - any stage completed but no in_progress -> "on_going"
 *   - all pending OR zero stages -> "not_started"
 *
 * Always called inside a parent transaction.
 */
export async function recalculateRenovationProgressStatus(
  tx: Prisma.TransactionClient,
  progressId: string,
): Promise<RenovationProgressStatus> {
  const rows = await tx.renovationStageProgress.findMany({
    where: { progressId },
    select: { status: true },
  });

  let status: RenovationProgressStatus = "not_started";
  if (rows.length > 0) {
    const total = rows.length;
    const completed = rows.filter((r) => r.status === "completed").length;
    const inProgress = rows.filter((r) => r.status === "in_progress").length;
    if (completed === total) status = "completed";
    else if (inProgress > 0 || completed > 0) status = "on_going";
  }

  const data: Record<string, unknown> = { status };
  if (status === "completed") {
    data.actualCompletion = new Date();
  } else {
    data.actualCompletion = null;
  }

  await tx.renovationProgress.update({ where: { id: progressId }, data });
  return status;
}
