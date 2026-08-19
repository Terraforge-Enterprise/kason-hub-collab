import { getDb, type Prisma } from "@kason/db";

// Decimal? columns serialise as strings over JSON. The InventoryListing wire
// type expects `bathrooms: number | null` and `floorArea: number | null`, so
// coerce at the repo boundary or filter equality (`[1].includes("1")`)
// silently fails.
function toNumber(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

/**
 * Convert a string[] of amenity UUIDs into the canonical wire shape
 * `{ id, name }[]`. Looks up each ID against a per-request catalog Map.
 *
 * Hard-deleted amenities (catalog row gone entirely) -> Map.get() returns
 * undefined -> that entry is filtered out. Soft-deleted amenities (isActive:
 * false) -> still in the map (caller's responsibility — the catalog query
 * MUST NOT filter by isActive when used for display) -> they still render.
 *
 * Both findListingsForAgent (portal listings) AND findUnitDetail (admin unit
 * detail) call this. Single source of truth for the wire shape.
 */
export function shapeAmenities(
  ids: string[],
  catalog: Map<string, string>,
): { id: string; name: string }[] {
  return ids
    .map((id) => {
      const name = catalog.get(id);
      return name ? { id, name } : null;
    })
    .filter((x): x is { id: string; name: string } => x !== null);
}

// Select shape used by the portal listings API. Listing scalars + an
// Apartment include so the wire mapper can pull apartment-shared fields
// (photos, amenities, bedrooms, ...) into the legacy top-level shape that
// `canAgentSeeUnit` and the SPA both depend on.
//
// Pending agent submissions live in UnitSubmission after the three-table
// refactor, so this select can never leak a non-approved row. The DB-level
// gate filters by `listingStatus="active" OR sourcingAgentId=agent`.
export const PORTAL_LISTING_SELECT = {
  id: true,
  listingType: true,
  rentalRate: true,
  currency: true,
  moveInDate: true,
  readyNow: true,
  occupancyStatus: true,
  inChargeName: true,
  inChargePartyId: true,
  inChargeParty: { select: { displayName: true } },
  depositMonths: true,
  utilitiesDepositMonths: true,
  accessCardDepositPerPcs: true,
  accessCardQuantity: true,
  parkingQuantity: true,
  parkingNumbers: true,
  vacantSince: true,
  listingStatus: true,
  visibilityMode: true,
  hiddenFromPartyIds: true,
  sourcingAgentId: true,
  sourcingAgent: { select: { displayName: true } },
  createdAt: true,
  photoKeys: true,
  coverPhotoKey: true,
  videoKeys: true,
  apartment: {
    select: {
      id: true,
      propertyId: true,
      unitCode: true,
      listingMode: true,
      bedrooms: true,
      bathrooms: true,
      floorArea: true,
      floor: true,
      facing: true,
      furnishingLevel: true,
      amenities: true,
      highlights: true,
      publishedDescription: true,
      publishedTitle: true,
      property: { select: { name: true, city: true, propertyCode: true } },
    },
  },
  // Latest active tenancy's endDate is the agent-facing "expected move-out"
  // forecast — not an actual move-out signal. We never auto-flip Tenancy.status,
  // so this reflects the scheduled lease end until ops manually edits it.
  tenancies: {
    where: { status: "active" },
    orderBy: { startDate: "desc" } as const,
    take: 1,
    select: { startDate: true, endDate: true },
  },
} as const;

/**
 * Prisma row type produced by `select: PORTAL_LISTING_SELECT`. The portal
 * `listVisibleUnits` path receives this exact shape; the mapper below
 * converts it to the legacy `InventoryListing` wire shape.
 */
export type PortalListingRow = Prisma.ListingGetPayload<{ select: typeof PORTAL_LISTING_SELECT }>;

/**
 * Single source of truth for shaping a Listing row into the canonical
 * portal `InventoryListing` wire shape. Spreads apartment-shared fields
 * (bedrooms, photos, amenities, ...) up to the top level so the SPA's
 * existing `unit.*` consumers keep working unchanged.
 *
 * Derived wire-compat fields:
 *   - sourceFlag: "AGENT_SOURCED" iff sourcingAgentId is non-null, else
 *     "COMPANY". The physical column no longer exists.
 *   - sourcingApproved: always true. Every Listing is approved by
 *     definition (pending submissions live in UnitSubmission).
 *
 * TODO (Phase C): drop the derived fields when the SPA migrates.
 */
export function shapeInventoryRow(
  row: PortalListingRow,
  amenityCatalog: Map<string, string>,
) {
  const apt = row.apartment;
  return {
    id: row.id,
    // Apartment-shared (top-level for wire compat).
    unitCode: apt.unitCode,
    unitType: row.listingType,
    listingType: row.listingType,
    bedrooms: apt.bedrooms,
    bathrooms: toNumber(apt.bathrooms),
    floorArea: toNumber(apt.floorArea),
    floor: apt.floor,
    facing: apt.facing,
    furnishingLevel: apt.furnishingLevel,
    highlights: apt.highlights,
    title: apt.publishedTitle ?? null,
    description: apt.publishedDescription ?? null,
    photoKeys: row.photoKeys,
    videoKeys: row.videoKeys,
    amenities: shapeAmenities(apt.amenities, amenityCatalog),
    // Listing-offer (commercial).
    rentalRate: toNumber(row.rentalRate),
    currency: row.currency,
    moveInDate: row.moveInDate,
    readyNow: row.readyNow,
    occupancyStatus: row.occupancyStatus,
    listingStatus: row.listingStatus,
    visibilityMode: row.visibilityMode,
    hiddenFromPartyIds: row.hiddenFromPartyIds,
    depositMonths: toNumber(row.depositMonths),
    utilitiesDepositMonths: toNumber(row.utilitiesDepositMonths),
    accessCardDepositPerPcs: toNumber(row.accessCardDepositPerPcs),
    accessCardQuantity: row.accessCardQuantity,
    parkingQuantity: row.parkingQuantity,
    parkingNumbers: row.parkingNumbers,
    vacantSince: row.vacantSince?.toISOString() ?? null,
    // In-charge resolution: prefer joined Party.displayName (canonical when
    // admin used the in-charge typeahead) and fall back to the legacy
    // free-text column for old rows that predate the typeahead.
    inChargeName: row.inChargeParty?.displayName ?? row.inChargeName ?? null,
    inChargePartyId: row.inChargePartyId,
    // Sourcing (denormalised on Listing for access checks).
    sourcingAgentId: row.sourcingAgentId,
    sourcingAgentName: row.sourcingAgent?.displayName ?? null,
    // Derived wire-compat. TODO: drop in Phase C.
    sourceFlag: (row.sourcingAgentId ? "AGENT_SOURCED" : "COMPANY") as
      | "AGENT_SOURCED"
      | "COMPANY",
    sourcingApproved: true,
    createdAt: row.createdAt,
    currentTenancyStartDate: row.tenancies[0]?.startDate?.toISOString() ?? null,
    currentTenancyEndDate: row.tenancies[0]?.endDate?.toISOString() ?? null,
    property: apt.property
      ? { name: apt.property.name, city: apt.property.city ?? null }
      : null,
  };
}

/**
 * Approved Listings the agent can see for the portal inventory grid.
 *
 * DB-level admit sets (disjoint):
 *   1. `listingStatus="active"` — admin has published the listing.
 *      Drafts/archived stay hidden from every agent, including the in-charge
 *      party (intentional — being in-charge of a draft does not grant
 *      browse visibility; the agent has a dedicated drafts surface).
 *   2. `sourcingAgentId === requesting agent` — the agent's own
 *      AGENT_SOURCED approved listings, regardless of listingStatus, so
 *      drafts they own remain editable.
 *
 * Pending submissions are physically NOT in this table after the three-table
 * refactor (they live in UnitSubmission). The legacy `excludeRejected` opt
 * is kept on the signature to avoid a parallel rewrite of the SPA call sites,
 * but it's a no-op now — there is no "rejected Listing" anymore (rejected =
 * UnitSubmission).
 *
 * RESTRICTED grants + hiddenFromPartyIds are gated downstream by
 * `canAgentSeeUnit` (service layer), not here.
 */
export async function findListingsForAgent(
  orgId: string,
  agentPartyId: string,
  _opts: { excludeRejected?: boolean } = {},
) {
  const [rows, amenityRows] = await Promise.all([
    getDb().listing.findMany({
      where: {
        organizationId: orgId,
        OR: [
          { listingStatus: "active" },
          { sourcingAgentId: agentPartyId },
        ],
      },
      select: PORTAL_LISTING_SELECT,
    }),
    // Load ALL amenities (incl. inactive) for display purposes. Soft-deleted
    // amenities still render on listings that already reference them.
    getDb().amenity.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    }),
  ]);
  const amenityCatalog = new Map(amenityRows.map((a) => [a.id, a.name]));
  return rows.map((row) => shapeInventoryRow(row, amenityCatalog));
}

/**
 * The agent's own UnitSubmissions in any state. Used by the portal "My
 * Uploads" view to render pending / needs_amendment / rejected / withdrawn
 * proposals alongside the agent's approved Listings. Approved submissions
 * also appear here so the SPA can show the full submission history; the
 * `approvedListing` back-pointer lets it cross-link to the live Listing.
 *
 * The two-list shape (approved Listings + Submissions) is the spec's
 * canonical "My Uploads" view; see §Web changes - Portal listings.
 */
export async function findOwnPendingSubmissions(
  orgId: string,
  agentPartyId: string,
) {
  return getDb().unitSubmission.findMany({
    where: { organizationId: orgId, sourcingAgentId: agentPartyId },
    orderBy: { createdAt: "desc" },
    include: {
      approvedListing: { select: { id: true } },
    },
  });
}

export async function findGrantsForAgent(orgId: string, agentPartyId: string) {
  return getDb().listingVisibilityGrant.findMany({
    where: { organizationId: orgId, partyId: agentPartyId },
    select: { unitId: true },
  });
}
