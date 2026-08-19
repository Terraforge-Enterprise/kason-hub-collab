// Admin API client for /api/renovation/* — list/get claims (editor+) and
// approve/reject/needs-amendment (manager+). Editors receive a metadata-only
// shape: `packagePrice`, `monthlyOffsetAmount`, `splits`, `documents` are
// surfaced as `null` from the server and must be treated as "not visible".
//
// The W4b portal agent ships a parallel `portal-renovation-claims.ts` for the
// agent flow; do NOT consolidate them — the role envelopes diverge.

import { apiFetch } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RenovationClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment";

export type RenovationPaymentType = "full" | "partial" | "offset_from_rental";

export type RenovationDocumentKind =
  | "quotation"
  | "invoice"
  | "agreement"
  | "progress_photo"
  | "before_photo"
  | "after_photo"
  | "contract";

export interface RenovationClaimSplit {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  isHouseKeep: boolean;
  sortOrder: number;
}

export interface RenovationClaimDocument {
  id: string;
  organizationId: string;
  claimId: string;
  kind: RenovationDocumentKind;
  fileKey: string;
  filename: string;
  uploadedAt: string;
  uploadedById: string;
}

/**
 * Wire shape of a renovation claim row from `/api/renovation/claims` and
 * `/api/renovation/claims/:id`. For editors, the gated fields
 * (`packagePrice`, `monthlyOffsetAmount`, `splits`, `documents`) are `null`.
 */
export interface RenovationClaim {
  id: string;
  organizationId: string;
  salesUnitId: string;
  packageId: string;
  packagePrice: number | null;
  paymentType: RenovationPaymentType;
  monthlyOffsetAmount: number | null;
  status: RenovationClaimStatus;
  notes: string | null;
  submittedAt: string;
  submittedById: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits: RenovationClaimSplit[] | null;
  documents: RenovationClaimDocument[] | null;
}

export interface ListClaimsFilters {
  status?: RenovationClaimStatus;
  salesUnitId?: string;
  submittedById?: string;
  /** ISO 8601 datetime. */
  submittedFrom?: string;
  /** ISO 8601 datetime. */
  submittedTo?: string;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export async function listRenovationClaims(
  filters: ListClaimsFilters = {},
): Promise<RenovationClaim[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.salesUnitId) params.set("salesUnitId", filters.salesUnitId);
  if (filters.submittedById) params.set("submittedById", filters.submittedById);
  if (filters.submittedFrom) params.set("submittedFrom", filters.submittedFrom);
  if (filters.submittedTo) params.set("submittedTo", filters.submittedTo);

  const qs = params.toString();
  const path = qs ? `/renovation/claims?${qs}` : "/renovation/claims";
  const res = await apiFetch<{ data: RenovationClaim[] }>(path);
  return res.data;
}

export async function getRenovationClaim(id: string): Promise<RenovationClaim> {
  const res = await apiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}`,
  );
  return res.data;
}

export interface RenovationClaimTransition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export async function listRenovationClaimTransitions(
  id: string,
): Promise<RenovationClaimTransition[]> {
  const res = await apiFetch<{ data: RenovationClaimTransition[] }>(
    `/renovation/claims/${id}/transitions`,
  );
  return res.data;
}

/**
 * Admin cancel — manager+. Returns 409 if the claim is already terminal.
 */
export async function cancelRenovationClaim(
  id: string,
  note?: string,
): Promise<RenovationClaim> {
  const res = await apiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}`,
    {
      method: "DELETE",
      body: JSON.stringify({ note: note ?? null }),
    },
  );
  return res.data;
}

export async function approveRenovationClaim(
  id: string,
): Promise<RenovationClaim> {
  const res = await apiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return res.data;
}

export async function rejectRenovationClaim(
  id: string,
  note: string,
): Promise<RenovationClaim> {
  const res = await apiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
  return res.data;
}

export async function needsAmendmentRenovationClaim(
  id: string,
  note: string,
): Promise<RenovationClaim> {
  const res = await apiFetch<{ data: RenovationClaim }>(
    `/renovation/claims/${id}/needs-amendment`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
  return res.data;
}

/**
 * Fetches a short-lived signed URL (≈1 hour) for an admin to view a claim
 * document. Editor+ — the API does NOT gate this on manager. Mirrors the
 * portal counterpart in `portal-renovation-claims.ts`.
 */
export async function getRenovationDocumentViewUrl(
  claimId: string,
  docId: string,
): Promise<{ viewUrl: string; expiresAt: string }> {
  const res = await apiFetch<{ data: { viewUrl: string; expiresAt: string } }>(
    `/renovation/claims/${claimId}/documents/${docId}/view-url`,
  );
  return res.data;
}

/**
 * Admin delete a document on a renovation claim. Manager+ — the route is
 * gated server-side. Storage object is removed and the documents array on
 * the parent claim is shrunk in one transaction.
 */
export async function deleteRenovationDocument(
  claimId: string,
  docId: string,
): Promise<void> {
  await apiFetch(`/renovation/claims/${claimId}/documents/${docId}`, {
    method: "DELETE",
  });
}
