/**
 * Portal sales-commission claims API client (agent-facing).
 *
 * Thin typed wrappers around the own-only routes shipped by
 * `apps/api/src/modules/portal/sales-claims/portal.sales-claims.routes.ts`.
 * Mirrors the `SalesClaimRow` / `SalesClaimSplitRow` shapes from
 * `apps/api/src/modules/sales-claims/sales-claims.types.ts`.
 *
 * All endpoints use the `portalApiFetch` helper, which prefixes
 * `/portal-api`, attaches credentials, and surfaces structured errors as
 * `PortalApiError`. Decimal → number conversion is done at the API repo
 * boundary; dates arrive as ISO strings over JSON.
 */
import { portalApiFetch } from "@/lib/portal-api";

export type SalesClaimStatus =
  | "submitted"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "needs_amendment";

export type SalesPaymentType = "full" | "partial";
export type CommissionType = "percent_of_purchase" | "fixed";
export type SplitType = "percent" | "fixed";

export interface SalesClaimSplit {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  sortOrder: number;
}

/** JSON-serialised mirror of `SalesClaimRow` (Date → ISO string). */
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

/** Own SalesUnit shape returned by `/portal-api/sales/units`. */
export interface OwnSalesUnit {
  id: string;
  organizationId: string;
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental: number | null;
  purchasePrice: number;
  agentPartyId: string;
  inChargePartyId: string | null;
  sourceFlag: string;
  sourcingApproved: boolean;
  sourcingApprovedById: string | null;
  sourcingApprovedAt: string | null;
  amendmentNotes: string | null;
  promotedUnitId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimSplitInput {
  partyPartyId?: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: number;
  sortOrder?: number;
}

export interface CreateSalesClaimPayload {
  salesUnitId: string;
  commissionType: CommissionType;
  commissionValue: number;
  paymentType: SalesPaymentType;
  notes?: string | null;
  splits: ClaimSplitInput[];
}

export interface UpdateSalesClaimPayload {
  commissionType?: CommissionType;
  commissionValue?: number;
  paymentType?: SalesPaymentType;
  notes?: string | null;
  splits?: ClaimSplitInput[];
}

export interface ListSalesClaimsFilters {
  status?: SalesClaimStatus;
  salesUnitId?: string;
}

function buildClaimsQs(filters: ListSalesClaimsFilters | undefined): string {
  if (!filters) return "";
  const sp = new URLSearchParams();
  if (filters.status) sp.set("status", filters.status);
  if (filters.salesUnitId) sp.set("salesUnitId", filters.salesUnitId);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listOwnSalesClaims(
  filters?: ListSalesClaimsFilters,
): Promise<{ data: SalesClaim[] }> {
  return portalApiFetch<{ data: SalesClaim[] }>(
    `/sales/claims${buildClaimsQs(filters)}`,
  );
}

export function getOwnSalesClaim(id: string): Promise<{ data: SalesClaim }> {
  return portalApiFetch<{ data: SalesClaim }>(`/sales/claims/${id}`);
}

export interface OwnSalesClaimTransition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export function listOwnSalesClaimTransitions(
  id: string,
): Promise<{ data: OwnSalesClaimTransition[] }> {
  return portalApiFetch<{ data: OwnSalesClaimTransition[] }>(
    `/sales/claims/${id}/transitions`,
  );
}

export function createOwnSalesClaim(
  payload: CreateSalesClaimPayload,
): Promise<{ data: SalesClaim }> {
  return portalApiFetch<{ data: SalesClaim }>(`/sales/claims`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOwnSalesClaim(
  id: string,
  payload: UpdateSalesClaimPayload,
): Promise<{ data: SalesClaim }> {
  return portalApiFetch<{ data: SalesClaim }>(`/sales/claims/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

/**
 * Withdraw an own claim. Server requires status="submitted" (any reviewer
 * touch locks the agent out — returns 409 otherwise).
 */
export function cancelOwnSalesClaim(
  id: string,
  note?: string,
): Promise<{ data: SalesClaim }> {
  return portalApiFetch<{ data: SalesClaim }>(`/sales/claims/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function listOwnSalesUnits(): Promise<{ data: OwnSalesUnit[] }> {
  return portalApiFetch<{ data: OwnSalesUnit[] }>(`/sales/units`);
}

// ─── Pure helpers (mirrored from server-side validators) ─────────────────────

const SPLIT_TOLERANCE = 0.01;

/**
 * Compute the commission amount the server will derive — used for live
 * preview only. Server is the source of truth.
 *   - percent_of_purchase: purchasePrice × commissionValue / 100
 *   - fixed:               commissionValue
 * Rounded to 2dp to match the schema's Decimal(14,2).
 */
export function computeSalesCommissionAmount(
  commissionType: CommissionType,
  commissionValue: number,
  purchasePrice: number,
): number {
  if (
    typeof commissionValue !== "number" ||
    !Number.isFinite(commissionValue) ||
    commissionValue < 0
  ) {
    return 0;
  }
  if (
    typeof purchasePrice !== "number" ||
    !Number.isFinite(purchasePrice) ||
    purchasePrice < 0
  ) {
    return 0;
  }
  const raw =
    commissionType === "percent_of_purchase"
      ? (purchasePrice * commissionValue) / 100
      : commissionValue;
  return Math.round(raw * 100) / 100;
}

/**
 * Mirror of the server's `validateSalesSplitsHundredPercent`. Runs the same
 * tolerance (RM 0.01) so the form's gate matches what the server enforces.
 */
export function checkSplitsHundredPercent(
  splits: { splitType: SplitType; splitValue: number }[],
  computedAmount: number,
): { ok: true; total: number } | { ok: false; total: number; error: string } {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: false, total: 0, error: "At least one split is required" };
  }
  if (
    typeof computedAmount !== "number" ||
    !Number.isFinite(computedAmount) ||
    computedAmount < 0
  ) {
    return { ok: false, total: 0, error: "Invalid computed amount" };
  }
  let total = 0;
  for (const s of splits) {
    if (
      typeof s.splitValue !== "number" ||
      !Number.isFinite(s.splitValue) ||
      s.splitValue < 0
    ) {
      return {
        ok: false,
        total,
        error: "Split value must be a non-negative number",
      };
    }
    if (s.splitType === "percent") {
      total += (computedAmount * s.splitValue) / 100;
    } else if (s.splitType === "fixed") {
      total += s.splitValue;
    } else {
      return { ok: false, total, error: "Unknown split type" };
    }
  }
  const diff = Math.abs(total - computedAmount);
  if (diff > SPLIT_TOLERANCE) {
    return {
      ok: false,
      total,
      error: `Splits must sum to RM ${computedAmount.toFixed(2)} (got RM ${total.toFixed(2)})`,
    };
  }
  return { ok: true, total };
}
