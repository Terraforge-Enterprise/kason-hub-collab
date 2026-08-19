// Portal-side typed client for /portal-api/inventory/*. Mirrors the
// portal-sales-claims / portal-renovation-claims pattern: own-only,
// server-enforced sourcing fields. Per unified-property-sourcing spec.

import { portalApiFetch } from "@/lib/portal-api";

export type PortalProperty = {
  // Approved Property rows have `id`; agent-pending properties carry
  // submissionId (and id is null) until admin approval.
  id: string | null;
  name: string;
  propertyCode: string;
  // Properties created by the caller can still be in submission state
  // ("pending" / "needs_amendment") — they remain selectable in the unit
  // picker while awaiting admin approval.
  status?: string;
  sourcingApproved?: boolean;
  // Carries the PropertySubmission id when this row is an agent-pending
  // proposal; null for approved Property rows. The create-unit form uses
  // it to attach a UnitSubmission to a pending property via
  // `propertySubmissionId`.
  submissionId?: string | null;
};

export type CreatePortalPropertyPayload = {
  name: string;
  propertyCode: string;
  propertyType: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
};

/**
 * Wire shape of `GET /portal-api/inventory/units` AFTER the three-table
 * refactor (2026-05-19).
 *
 * Each row is a `UnitSubmission` — the agent-side proposal artifact — not
 * the old Unit row. The submission's `submittedPayload` is a JSON blob with
 * the proposed `listing` and `apartmentShared` fields; consumers that need
 * commercial data (rentalRate, deposits) read from `submittedPayload`.
 *
 * Status flow:
 *   pending → needs_amendment → pending → approved
 *   pending → rejected (terminal)
 *   pending → withdrawn (terminal)
 *
 * The legacy `sourceFlag`, `sourcingApproved`, `pendingChanges`,
 * `sourcingAmendmentNote`, `sourcingCancelled` fields no longer exist —
 * status is now first-class via `submissionState`.
 */
export type PortalOwnUnit = {
  id: string;
  // null when this submission targets a PropertySubmission (pending property)
  propertyId: string | null;
  unitCode: string;
  // Legacy SPA alias for `listingType` — kept for back-compat with components
  // that already read `unit.unitType`. Both fields carry the same value.
  unitType: string;
  listingType: string;
  listingMode: "WHOLE" | "PARTITIONED";
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  // Set when this submission is an amendment to an existing approved Listing.
  parentListingId: string | null;
  // Set after admin approves; back-points to the live Listing.
  approvedListingId: string | null;
  approvedListing: { id: string } | null;
  sourcingAgentId: string;
  // The full proposed payload — { listing, apartmentShared }.
  submittedPayload: Record<string, unknown> | null;
  property: {
    id: string;
    name: string;
    propertyCode: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePortalUnitPayload = {
  propertyId: string;
  unitCode: string;
  unitType: string;
  bedrooms?: number;
  bathrooms?: number;
  rentalRate?: number;
  floor?: number;
  floorArea?: number;
  occupancyStatus?: string;
  listingStatus?: string;
  visibilityMode?: "PUBLIC" | "RESTRICTED";
  amenities?: string[];
  // Apartment-level free-form selling points; never per-room. Optional
  // because older clients may omit it.
  highlights?: string[];
  description?: string | null;
  depositMonths?: number;
  utilitiesDepositMonths?: number;
  accessCardDepositPerPcs?: number;
  accessCardQuantity?: number;
  parkingQuantity?: number;
  parkingNumbers?: string[];
};

export type UpdatePortalUnitPayload = Partial<
  Omit<CreatePortalUnitPayload, "propertyId">
>;

export async function listOwnPortalUnits(): Promise<PortalOwnUnit[]> {
  const res = await portalApiFetch<{ data: PortalOwnUnit[] }>(
    "/inventory/units",
  );
  return res.data;
}

export async function listPortalProperties(): Promise<PortalProperty[]> {
  const res = await portalApiFetch<{ data: PortalProperty[] }>(
    "/inventory/properties",
  );
  return res.data;
}

// Create a new property as an agent. Lands in the admin source queue
// (status="pending", sourcingApproved=false). The new property remains
// pickable in the unit picker for the caller while pending.
export async function createPortalProperty(
  body: CreatePortalPropertyPayload,
): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    "/inventory/properties",
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.data;
}

export async function createPortalUnit(
  body: CreatePortalUnitPayload,
): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    "/inventory/units",
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.data;
}

// Batch — multi-room submission. Shared apartment metadata + N rooms (each
// with its own type/rent/deposit/parking). All-or-none on the server.
export type CreatePortalUnitsBatchSharedFields = {
  propertyId: string;
  unitCode: string;
  floor?: number;
  bedrooms?: number;
  bathrooms?: number;
  floorArea?: number;
  amenities?: string[];
  // Per-apartment free-form selling points; renders as chips, feeds
  // full-text search but not a filter facet.
  highlights?: string[];
  description?: string | null;
};

export type CreatePortalUnitsBatchRoom = {
  unitType: string;
  rentalRate?: number;
  depositMonths?: number;
  utilitiesDepositMonths?: number;
  accessCardDepositPerPcs?: number;
  accessCardQuantity?: number;
  parkingQuantity?: number;
  parkingNumbers?: string[];
};

export type CreatePortalUnitsBatchPayload = {
  shared: CreatePortalUnitsBatchSharedFields;
  rooms: CreatePortalUnitsBatchRoom[];
  // Opt-in fan-out: server rewrites apartment-scoped fields on every
  // existing sibling row. Portal also enforces ownership (caller must
  // own every existing sibling, else 403 APARTMENT_NOT_OWNED).
  applyToExistingSiblings?: boolean;
};

export async function createPortalUnitsBatch(
  body: CreatePortalUnitsBatchPayload,
): Promise<{ ids: string[]; updatedIds: string[] }> {
  const res = await portalApiFetch<{
    data: { ids: string[]; updatedIds: string[] };
  }>("/inventory/units/batch", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.data;
}

// Wire shape of GET /portal-api/inventory/apartments/by-property/:propertyId.
// Mirrors the server's ApartmentSummary. Portal version filters to apartments
// where the agent has at least one visible sibling; rooms[] only includes
// visible siblings. Apartment-scoped fields are canonical (admin-view-agreed).
export type PortalApartmentRoomSummary = {
  id: string;
  unitType: string;
  rentalRate: number | null;
  occupancyStatus: string | null;
  listingStatus: string;
  inChargePartyId: string | null;
};

export type PortalApartmentSummary = {
  unitCode: string;
  floor: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  amenities: { id: string; name: string }[];
  highlights: string[];
  description: string | null;
  rooms: PortalApartmentRoomSummary[];
  hasDrift: boolean;
  listingMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
};

export async function portalGetApartmentsByProperty(
  propertyId: string,
): Promise<PortalApartmentSummary[]> {
  const res = await portalApiFetch<{ data: PortalApartmentSummary[] }>(
    `/inventory/apartments/by-property/${propertyId}`,
  );
  return res.data;
}

export async function updatePortalUnit(
  id: string,
  body: UpdatePortalUnitPayload,
): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    `/inventory/units/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return res.data;
}

export async function cancelPortalUnit(id: string): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    `/inventory/units/${id}`,
    { method: "DELETE" },
  );
  return res.data;
}

// ── Agent-side PropertySubmission lifecycle (My Uploads → Properties) ────
// Companions to listOwnPortalUnits + updatePortalUnit + cancelPortalUnit.

export type PortalOwnPropertyListRow = {
  id: string;
  name: string;
  propertyCode: string;
  propertyType: string;
  submissionState:
    | "pending"
    | "needs_amendment"
    | "approved"
    | "rejected"
    | "withdrawn";
  amendmentNote: string | null;
  approvedPropertyId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PortalOwnPropertyDetail = {
  id: string;
  propertyCode: string;
  proposedName: string;
  propertyType: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  submissionState:
    | "pending"
    | "needs_amendment"
    | "approved"
    | "rejected"
    | "withdrawn";
  amendmentNote: string | null;
  approvedPropertyId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdatePortalPropertyPayload = {
  propertyCode: string;
  proposedName: string;
  propertyType: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state?: string | null;
  postalCode?: string | null;
  country: string;
};

export type PortalCascadeBlockedError = {
  error: "PROPERTY_HAS_PENDING_UNITS";
  blockingUnitIds: string[];
};

export async function listOwnPortalProperties(): Promise<PortalOwnPropertyListRow[]> {
  const res = await portalApiFetch<{ data: PortalOwnPropertyListRow[] }>(
    "/inventory/properties/own",
  );
  return res.data;
}

export async function getOwnPortalProperty(
  id: string,
): Promise<PortalOwnPropertyDetail> {
  const res = await portalApiFetch<{ data: PortalOwnPropertyDetail }>(
    `/inventory/properties/own/${id}`,
  );
  return res.data;
}

export async function updateOwnPortalProperty(
  id: string,
  body: UpdatePortalPropertyPayload,
): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    `/inventory/properties/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return res.data;
}

export async function withdrawOwnPortalProperty(
  id: string,
): Promise<{ id: string }> {
  const res = await portalApiFetch<{ data: { id: string } }>(
    `/inventory/properties/${id}`,
    { method: "DELETE" },
  );
  return res.data;
}
