/**
 * Rental inventory source-queue API client (admin · manager+).
 *
 * After the three-table refactor, pending agent-sourced inventory rows live
 * in `UnitSubmission` — not on `Listing.sourcingApproved=false`. The unified
 * `/api/source-queue` endpoint now returns UnitSubmission rows in its
 * `units[]` array. The old per-listing approve/reject/needs-amendment
 * endpoints on `/listings/:id/*` have been removed.
 *
 * Submission approve/reject routes are wired in a later task (post C-series);
 * the helpers below throw a clear runtime error if invoked before that lands.
 * The submission service code itself exists at
 * `apps/api/src/modules/submissions/submission.service.ts`.
 *
 * Spec: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md §Web changes
 */
import { apiFetch } from "@/lib/api-client";

/**
 * Wire shape of a pending `UnitSubmission` as returned by the new
 * `/api/source-queue` endpoint. The full submittedPayload JSON is present
 * for diff display in the admin UI.
 */
export interface RentalSourceQueueRow {
  id: string;
  organizationId: string;
  propertyId: string | null;
  propertySubmissionId: string | null;
  unitCode: string;
  listingType: string;
  listingMode: "WHOLE" | "PARTITIONED";
  parentListingId: string | null;
  sourcingAgentId: string | null;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  // The full proposed payload — { listing: {...}, apartmentShared: {...} }.
  submittedPayload: Record<string, unknown> | null;
  approvedAt: string | null;
  approvedById: string | null;
  approvedListingId: string | null;
  createdAt: string;
  updatedAt: string;
  // Nested when the parent Property is already approved.
  property: { id: string; name: string; propertyCode: string } | null;
  // Nested when the parent Property hasn't been approved yet — the
  // submission still has agent-supplied name/code we can show.
  propertySubmission: { id: string; proposedName: string; propertyCode: string } | null;
}

/**
 * TODO (Phase C follow-up): the unified source queue is now under
 * `/api/source-queue` — the per-domain `/inventory/source-queue` route was
 * removed. The admin source-queue page consumes the unified payload directly
 * via `getSourceQueue()` from `@/api/source-queue`. This shim returns the
 * `units` portion of the unified payload for back-compat with code paths
 * that still expect a flat list.
 */
export async function listRentalSourceQueue(): Promise<{ data: RentalSourceQueueRow[] }> {
  const res = await apiFetch<{
    data: { units: RentalSourceQueueRow[] };
  }>("/source-queue");
  return { data: res.data.units };
}

/**
 * Submission approve route is not wired yet — the submissions module has
 * the service but no HTTP surface. When the route lands it'll be
 * `POST /api/source-queue/unit-submissions/:id/approve`. Until then this
 * throws a runtime error so the operator sees a clear "not yet wired"
 * signal instead of a silent 404.
 *
 * TODO (Phase C follow-up): wire `/api/source-queue/unit-submissions/*`.
 */
export function approveRentalListing(id: string): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/unit-submissions/${id}/approve`,
    { method: "POST" },
  );
}

export function rejectRentalListing(
  id: string,
  note: string,
): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/unit-submissions/${id}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}

export function needsAmendmentRentalListing(
  id: string,
  note: string,
): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(
    `/source-queue/unit-submissions/${id}/needs-amendment`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}
