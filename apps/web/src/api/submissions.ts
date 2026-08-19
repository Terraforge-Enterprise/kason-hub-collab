// apps/web/src/api/submissions.ts
//
// Typed clients for UnitSubmission + PropertySubmission endpoints (admin
// source-queue side AND portal-side flows). New file as part of the
// three-table refactor (2026-05-19).
//
// IMPORTANT: the admin source-queue mutation routes
// (`/api/source-queue/unit-submissions/:id/approve` etc.) are not wired in
// the API yet — the submission *service* exists at
// `apps/api/src/modules/submissions/submission.service.ts`, but the HTTP
// surface lands in a follow-up task. Until then the helpers below will
// surface a 404 toast. Mark TODOs accordingly.
//
// Spec: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md
//       §Web changes - API client

import { apiFetch } from "@/lib/api-client";
import { portalApiFetch } from "@/lib/portal-api";

/**
 * Wire shape of a `UnitSubmission` row. Matches the
 * `UNIT_SUBMISSION_SELECT` projection from
 * `apps/api/src/modules/submissions/submission.repository.ts`.
 */
export type UnitSubmission = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  propertySubmissionId: string | null;
  unitCode: string;
  listingType: string;
  listingMode: "WHOLE" | "PARTITIONED";
  parentListingId: string | null;
  sourcingAgentId: string;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  submittedPayload: Record<string, unknown> | null;
  approvedAt: string | null;
  approvedById: string | null;
  approvedListingId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Wire shape of a `PropertySubmission` row.
 */
export type PropertySubmission = {
  id: string;
  propertyCode: string;
  proposedName: string;
  propertyType: string;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  sourcingAgentId: string;
  approvedPropertyId: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Admin side ──────────────────────────────────────────────────────────

/**
 * The unified source-queue payload. Lists all pending agent-sourced rows
 * across sales, rental, and property submissions in one round-trip.
 */
export type UnifiedSourceQueueResponse = {
  // SalesUnit rows (legacy table; unaffected by the refactor).
  salesUnits: unknown[];
  // UnitSubmission rows.
  units: UnitSubmission[];
  // PropertySubmission rows.
  properties: PropertySubmission[];
};

export async function getUnifiedSourceQueue(): Promise<UnifiedSourceQueueResponse> {
  const res = await apiFetch<{ data: UnifiedSourceQueueResponse }>("/source-queue");
  return res.data;
}

/**
 * TODO (Phase C follow-up): wire `/api/source-queue/unit-submissions/*`
 * routes. The submission service is ready; only the HTTP routes are
 * missing.
 */
export async function approveUnitSubmission(submissionId: string): Promise<{ data: { approvedListingId: string } }> {
  return apiFetch<{ data: { approvedListingId: string } }>(
    `/source-queue/unit-submissions/${submissionId}/approve`,
    { method: "POST" },
  );
}

export async function rejectUnitSubmission(
  submissionId: string,
  note: string,
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(
    `/source-queue/unit-submissions/${submissionId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}

export async function setUnitSubmissionNeedsAmendment(
  submissionId: string,
  note: string,
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(
    `/source-queue/unit-submissions/${submissionId}/needs-amendment`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}

// ─── Portal (agent) side ─────────────────────────────────────────────────

/**
 * Withdraw a pending / needs_amendment submission. Maps to
 * `DELETE /portal-api/inventory/units/:id` — the portal inventory route
 * resolves the id to a UnitSubmission and routes the cancel through the
 * `withdrawSubmissionService` (transitions submissionState → "withdrawn").
 */
export async function withdrawOwnSubmission(submissionId: string): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    `/inventory/units/${submissionId}`,
    { method: "DELETE" },
  );
  return res.data;
}
