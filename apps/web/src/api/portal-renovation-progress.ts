import { portalApiFetch } from "@/lib/portal-api";

export type StageStatus = "pending" | "in_progress" | "completed";

export function flipStageStatus(
  progressId: string,
  stageProgressId: string,
  body: { status: StageStatus; note?: string },
): Promise<{ data: { id: string; status: StageStatus; progressStatus: "not_started" | "on_going" | "completed" } }> {
  return portalApiFetch(`/renovation/progress/${progressId}/stage/${stageProgressId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function markRenovationComplete(
  progressId: string,
): Promise<{ data: { id: string; status: "completed" } }> {
  return portalApiFetch(`/renovation/progress/${progressId}/mark-complete`, {
    method: "POST",
  });
}
