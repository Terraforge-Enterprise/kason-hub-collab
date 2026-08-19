/**
 * Sales pipeline API client (admin).
 *
 * Thin typed wrappers around the SalesUnit + RenovationProgress endpoints
 * shipped by `apps/api/src/modules/sales/sales.routes.ts`. Mirrors the
 * `SalesUnitRow` / `RenovationProgressRow` / `RenovationTransitionRow`
 * shapes from `apps/api/src/modules/sales/sales.types.ts`.
 *
 * Decimal → number is done at the API repo boundary; dates arrive as ISO
 * strings over JSON despite the `Date` type in the server-side type.
 */
import { apiFetch } from "@/lib/api-client";

export type RenovationStatus = "not_started" | "on_going" | "completed";
export type SalesPurpose = "rent" | "own_stay";

/** Mirror of `SalesUnitRow` after JSON serialisation (Date → string). */
export interface SalesUnit {
  id: string;
  organizationId: string;
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string;
  purpose: SalesPurpose;
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

export interface RenovationTransition {
  id: string;
  organizationId: string;
  progressId: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedAt: string;
  note: string | null;
}

export interface SalesProject {
  id: string;
  organizationId: string;
  name: string;
  developer: string;
  city: string | null;
  expectedHandover: string | null;
  status: string;
  promotedPropertyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
}

export interface ListSalesUnitsFilters {
  projectId?: string;
  /** Server expects "true" | "false" — we serialise booleans here. */
  sourcingApproved?: boolean;
  /** ISO datetime, inclusive lower bound for `salesDate`. */
  salesDateFrom?: string;
  /** ISO datetime, inclusive upper bound for `salesDate`. */
  salesDateTo?: string;
  /** Free-text — matched against `unitNumber` and owner display name. */
  q?: string;
}

function buildSalesUnitsQs(filters: ListSalesUnitsFilters | undefined): string {
  if (!filters) return "";
  const sp = new URLSearchParams();
  if (filters.projectId) sp.set("projectId", filters.projectId);
  if (filters.sourcingApproved !== undefined) {
    sp.set("sourcingApproved", filters.sourcingApproved ? "true" : "false");
  }
  if (filters.salesDateFrom) sp.set("salesDateFrom", filters.salesDateFrom);
  if (filters.salesDateTo) sp.set("salesDateTo", filters.salesDateTo);
  if (filters.q) sp.set("q", filters.q);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listSalesUnits(
  filters?: ListSalesUnitsFilters,
): Promise<{ data: SalesUnit[] }> {
  return apiFetch<{ data: SalesUnit[] }>(`/sales/units${buildSalesUnitsQs(filters)}`);
}

export function getSalesUnit(id: string): Promise<{ data: SalesUnit }> {
  return apiFetch<{ data: SalesUnit }>(`/sales/units/${id}`);
}

export interface UpdateSalesUnitPayload {
  projectId?: string;
  unitNumber?: string;
  ownerPartyId?: string;
  salesDate?: string;
  purpose?: SalesPurpose;
  bedrooms?: number;
  bathrooms?: number;
  parkingLots?: number;
  expectedRental?: number | null;
  purchasePrice?: number;
  inChargePartyId?: string | null;
}

export function updateSalesUnit(
  id: string,
  payload: UpdateSalesUnitPayload,
): Promise<{ data: SalesUnit }> {
  return apiFetch<{ data: SalesUnit }>(`/sales/units/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export interface CreateSalesUnitPayload {
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string;
  purpose: SalesPurpose;
  bedrooms: number;
  bathrooms: number;
  parkingLots?: number;
  expectedRental?: number;
  purchasePrice: number;
  agentPartyId?: string;
  inChargePartyId?: string | null;
}

export function createSalesUnit(
  payload: CreateSalesUnitPayload,
): Promise<{ data: SalesUnit }> {
  return apiFetch<{ data: SalesUnit }>(`/sales/units`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface SetRenovationStatusPayload {
  status: RenovationStatus;
  startDate?: string | null;
  expectedCompletion?: string | null;
  actualCompletion?: string | null;
  note?: string | null;
}

export interface SetRenovationStatusResponse {
  progress: {
    id: string;
    organizationId: string;
    salesUnitId: string;
    status: RenovationStatus;
    startDate: string | null;
    expectedCompletion: string | null;
    actualCompletion: string | null;
    notes: string | null;
    updatedAt: string;
    updatedById: string | null;
  };
  salesUnit: SalesUnit;
  /** Non-null when the transition triggered an auto-promote into rental inventory. */
  promotedUnitId: string | null;
}

export function setRenovationStatus(
  id: string,
  payload: SetRenovationStatusPayload,
): Promise<{ data: SetRenovationStatusResponse }> {
  return apiFetch<{ data: SetRenovationStatusResponse }>(
    `/sales/units/${id}/renovation`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export function listRenovationTransitions(
  id: string,
): Promise<{ data: RenovationTransition[] }> {
  return apiFetch<{ data: RenovationTransition[] }>(
    `/sales/units/${id}/renovation/transitions`,
  );
}

export function listSalesProjects(): Promise<{ data: SalesProject[] }> {
  return apiFetch<{ data: SalesProject[] }>(`/projects`);
}

export type CreateAdminProjectPayload = {
  name: string;
  developer: string;
  city?: string;
  expectedHandover?: string; // ISO datetime
  status?: "active" | "unverified" | "archived";
  notes?: string;
};

/**
 * Admin creates a Project. Manager+ — server enforces. Used by the new
 * "+ New Project" button on the admin sales pipeline so admins can add
 * projects directly instead of asking an agent to do it via the portal
 * (which lands in the unverified queue and needs admin approval anyway).
 */
export function createSalesProject(
  payload: CreateAdminProjectPayload,
): Promise<{ data: SalesProject }> {
  return apiFetch<{ data: SalesProject }>(`/projects`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
