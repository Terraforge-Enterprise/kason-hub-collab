/**
 * Portal sales pipeline API client (agent-facing).
 *
 * Thin typed wrappers around the agent-only SalesUnit + Project endpoints
 * mounted at `/portal-api/sales/units` and `/portal-api/projects`.
 *
 * Mirrors `SalesUnitRow` / `ProjectRow` from the API after JSON
 * serialisation: `Date` → ISO string, `Decimal` → number (the repository
 * boundary normalises both before responding).
 *
 * CSRF + 401-redirect handling lives in `portalApiFetch`.
 */
import { portalApiFetch } from "@/lib/portal-api";

export type SalesPurpose = "rent" | "own_stay";

/**
 * Row shape returned by `GET /portal-api/sales/units` and
 * `GET /portal-api/sales/units/:id`. The portal route restricts the list
 * to rows where `agentPartyId === session.partyId`.
 */
export interface PortalSalesUnit {
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

/** Mirror of `ProjectRow` after JSON serialisation. */
export interface PortalProject {
  id: string;
  organizationId: string;
  name: string;
  developer: string;
  city: string | null;
  expectedHandover: string | null;
  /** "active" | "unverified" | "archived" — portal-created start as "unverified". */
  status: string;
  promotedPropertyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string | null;
}

// ─── Sales units ────────────────────────────────────────────────────────────

export interface ListPortalSalesUnitsFilters {
  projectId?: string;
  /** Server expects "true" | "false" — booleans are serialised here. */
  sourcingApproved?: boolean;
  /** ISO datetime, inclusive lower bound for `salesDate`. */
  salesDateFrom?: string;
  /** ISO datetime, inclusive upper bound for `salesDate`. */
  salesDateTo?: string;
  /** Free-text — matched against `unitNumber` and owner display name. */
  q?: string;
}

function buildSalesUnitsQs(
  filters: ListPortalSalesUnitsFilters | undefined,
): string {
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

export function listPortalSalesUnits(
  filters?: ListPortalSalesUnitsFilters,
): Promise<{ data: PortalSalesUnit[] }> {
  return portalApiFetch<{ data: PortalSalesUnit[] }>(
    `/sales/units${buildSalesUnitsQs(filters)}`,
  );
}

export function getPortalSalesUnit(
  id: string,
): Promise<{ data: PortalSalesUnit }> {
  return portalApiFetch<{ data: PortalSalesUnit }>(`/sales/units/${id}`);
}

export interface CreatePortalSalesUnitPayload {
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  /** ISO datetime — the validator requires the full datetime form. */
  salesDate: string;
  purpose: SalesPurpose;
  /** -1 (Studio) or 1..4 (4 = "4+"). */
  bedrooms: number;
  /** 1..3 (3 = "3+"). */
  bathrooms: number;
  parkingLots?: number;
  /** Required when `purpose === "rent"` (UI gate; backend also accepts on own_stay). */
  expectedRental?: number;
  purchasePrice: number;
  inChargePartyId?: string | null;
}

export function createPortalSalesUnit(
  payload: CreatePortalSalesUnitPayload,
): Promise<{ data: PortalSalesUnit }> {
  return portalApiFetch<{ data: PortalSalesUnit }>(`/sales/units`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface UpdatePortalSalesUnitPayload {
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

export function updatePortalSalesUnit(
  id: string,
  payload: UpdatePortalSalesUnitPayload,
): Promise<{ data: PortalSalesUnit }> {
  return portalApiFetch<{ data: PortalSalesUnit }>(`/sales/units/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ─── Projects ───────────────────────────────────────────────────────────────

export interface ListPortalProjectsFilters {
  status?: "active" | "unverified" | "archived";
  q?: string;
}

function buildProjectsQs(
  filters: ListPortalProjectsFilters | undefined,
): string {
  if (!filters) return "";
  const sp = new URLSearchParams();
  if (filters.status) sp.set("status", filters.status);
  if (filters.q) sp.set("q", filters.q);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function listPortalProjects(
  filters?: ListPortalProjectsFilters,
): Promise<{ data: PortalProject[] }> {
  return portalApiFetch<{ data: PortalProject[] }>(
    `/projects${buildProjectsQs(filters)}`,
  );
}

export interface CreatePortalProjectPayload {
  name: string;
  developer: string;
  city?: string;
  /** ISO datetime if supplied — the validator requires datetime, not just date. */
  expectedHandover?: string;
  notes?: string;
}

/**
 * Creates a Project from the agent portal. The server forces
 * `status = "unverified"` regardless of what we pass — managers must promote
 * to "active" before SalesUnits are accepted against it on the admin side.
 */
export function createPortalProject(
  payload: CreatePortalProjectPayload,
): Promise<{ data: PortalProject }> {
  return portalApiFetch<{ data: PortalProject }>(`/projects`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ─── Status derivation ──────────────────────────────────────────────────────

/**
 * Six-state UI status derived from `sourcingApproved` + `amendmentNotes`.
 * The backend doesn't expose a single `status` column — it's a function of
 * those two fields plus the audit trail. The portal cannot distinguish
 * "rejected" from "needs amendment" without the audit log, so both surface
 * as "needs_amendment" here (the agent's recovery action is identical).
 *
 * `edited_post_approval` is detected from the literal note string written
 * by `updateSalesUnitService` when `rebindOnApproval` rebinds an approved
 * row back into the source-approval queue after an agent edit.
 */
export type SalesUnitStatus =
  | "pending_review"
  | "approved"
  | "needs_amendment"
  | "edited_post_approval";

export const POST_APPROVAL_REBIND_NOTE = "Edited by agent post-approval";

export function deriveSalesUnitStatus(unit: PortalSalesUnit): SalesUnitStatus {
  if (unit.sourcingApproved) return "approved";
  if (unit.amendmentNotes === POST_APPROVAL_REBIND_NOTE) {
    return "edited_post_approval";
  }
  if (unit.amendmentNotes && unit.amendmentNotes.trim().length > 0) {
    return "needs_amendment";
  }
  return "pending_review";
}

export const SALES_UNIT_STATUS_LABEL: Record<SalesUnitStatus, string> = {
  pending_review: "Pending Review",
  approved: "Approved",
  needs_amendment: "Needs Amendment",
  edited_post_approval: "Edited Post-Approval",
};
