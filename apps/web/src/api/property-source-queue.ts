/**
 * Property inventory source-queue API client (admin · manager+).
 *
 * Wraps the PropertySubmission lifecycle endpoints under
 * `/api/source-queue/property-submissions/...`. Restored 2026-05-21 (the
 * post-C-series Phase-C follow-up the three-table refactor punted on).
 *
 * Mirrors the UnitSubmission helpers in `inventory-source-queue.ts`.
 */
import { apiFetch } from "@/lib/api-client";

/**
 * Wire shape of a pending `PropertySubmission` as returned by the unified
 * `/api/source-queue` endpoint or the dedicated
 * `/api/source-queue/property-submissions` list.
 */
export interface PropertySourceQueueRow {
  id: string;
  propertyCode: string;
  proposedName: string;
  propertyType: string;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  sourcingAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listPropertySourceQueue(): Promise<{ data: PropertySourceQueueRow[] }> {
  const res = await apiFetch<{
    data: { properties: PropertySourceQueueRow[] };
  }>("/source-queue");
  return { data: res.data.properties };
}

export function approvePropertySubmission(id: string): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/property-submissions/${id}/approve`,
    { method: "POST" },
  );
}

export function rejectPropertySubmission(
  id: string,
  note: string,
): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/property-submissions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

export function needsAmendmentPropertySubmission(
  id: string,
  note: string,
): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/property-submissions/${id}/needs-amendment`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}
