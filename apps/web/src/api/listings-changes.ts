// Admin client for the pending-changes review flow.
//
// - listPendingChanges() drives the "Pending re-approval" section on the
//   admin source-queue page (every Listing where pendingChanges IS NOT NULL).
// - approveListingChanges() merges pendingChanges into the row server-side.
// - rejectListingChanges() clears pendingChanges; an optional note is
//   forwarded to the API for audit/notification purposes.
//
// All three endpoints are Manager+ gated server-side.

import { apiFetch } from "@/lib/api-client";

export function approveListingChanges(id: string): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(`/listings/${id}/approve-changes`, { method: "POST" });
}

export function rejectListingChanges(
  id: string,
  note?: string,
): Promise<{ data: unknown }> {
  return apiFetch<{ data: unknown }>(`/listings/${id}/reject-changes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export type PendingChangesRow = {
  id: string;
  unitCode: string;
  unitType: string;
  rentalRate: number | null;
  currency: string;
  sourcingAgentId: string | null;
  pendingChanges: Record<string, unknown> | null;
  pendingChangesSubmittedAt: string | null;
  pendingChangesSubmittedById: string | null;
  property: { id: string; name: string; propertyCode: string };
};

export function listPendingChanges(): Promise<{ data: PendingChangesRow[] }> {
  return apiFetch<{ data: PendingChangesRow[] }>("/source-queue/pending-changes");
}
