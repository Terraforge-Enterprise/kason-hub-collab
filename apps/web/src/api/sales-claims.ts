// Admin API client for /api/sales/claims/* — list/get claims (editor+) and
// approve/reject/needs-amendment (manager+). Editors receive a metadata-only
// shape: `commissionValue`, `computedAmount`, `splits` are surfaced as `null`
// from the server and must be treated as "not visible".
//
// The W4c portal agent ships a parallel `portal-sales-claims.ts` for the
// agent flow; do NOT consolidate them — the role envelopes diverge.

import { apiFetch } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SalesClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment";

export type SalesPaymentType = "full" | "partial";

export type CommissionType = "percent_of_purchase" | "fixed";

export interface SalesClaimSplit {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  sortOrder: number;
}

/**
 * Wire shape of a sales claim row from `/api/sales/claims` and
 * `/api/sales/claims/:id`. For editors, the gated fields
 * (`commissionValue`, `computedAmount`, `splits`) are `null`.
 */
export interface SalesClaim {
  id: string;
  organizationId: string;
  salesUnitId: string;
  commissionType: CommissionType;
  commissionValue: number | null;
  computedAmount: number | null;
  paymentType: SalesPaymentType;
  status: SalesClaimStatus;
  notes: string | null;
  submittedAt: string;
  submittedById: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits: SalesClaimSplit[] | null;
}

export interface ListClaimsFilters {
  status?: SalesClaimStatus;
  salesUnitId?: string;
  submittedById?: string;
  /** ISO 8601 datetime. */
  submittedFrom?: string;
  /** ISO 8601 datetime. */
  submittedTo?: string;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export async function listSalesClaims(
  filters: ListClaimsFilters = {},
): Promise<SalesClaim[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.salesUnitId) params.set("salesUnitId", filters.salesUnitId);
  if (filters.submittedById) params.set("submittedById", filters.submittedById);
  if (filters.submittedFrom) params.set("submittedFrom", filters.submittedFrom);
  if (filters.submittedTo) params.set("submittedTo", filters.submittedTo);

  const qs = params.toString();
  const path = qs ? `/sales/claims?${qs}` : "/sales/claims";
  const res = await apiFetch<{ data: SalesClaim[] }>(path);
  return res.data;
}

export async function getSalesClaim(id: string): Promise<SalesClaim> {
  const res = await apiFetch<{ data: SalesClaim }>(`/sales/claims/${id}`);
  return res.data;
}

export interface SalesClaimTransition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export async function listSalesClaimTransitions(
  id: string,
): Promise<SalesClaimTransition[]> {
  const res = await apiFetch<{ data: SalesClaimTransition[] }>(
    `/sales/claims/${id}/transitions`,
  );
  return res.data;
}

/**
 * Admin cancel — manager+. Used to clean up duplicates or mis-submitted
 * claims. Returns 409 if the claim is already in a terminal state.
 */
export async function cancelSalesClaim(
  id: string,
  note?: string,
): Promise<SalesClaim> {
  const res = await apiFetch<{ data: SalesClaim }>(`/sales/claims/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ note: note ?? null }),
  });
  return res.data;
}

export async function approveSalesClaim(id: string): Promise<SalesClaim> {
  const res = await apiFetch<{ data: SalesClaim }>(
    `/sales/claims/${id}/approve`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return res.data;
}

export async function rejectSalesClaim(
  id: string,
  note: string,
): Promise<SalesClaim> {
  const res = await apiFetch<{ data: SalesClaim }>(
    `/sales/claims/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
  return res.data;
}

export async function needsAmendmentSalesClaim(
  id: string,
  note: string,
): Promise<SalesClaim> {
  const res = await apiFetch<{ data: SalesClaim }>(
    `/sales/claims/${id}/needs-amendment`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
  return res.data;
}
