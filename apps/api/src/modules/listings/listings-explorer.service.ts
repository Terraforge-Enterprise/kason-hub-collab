import { getDb, type Prisma } from "@kason/db";
import { createSignedDownloadUrl } from "../../lib/storage";

/**
 * Admin-scoped inventory explorer.
 *
 * Returns one row per Listing in the org with its parent Apartment +
 * Property joined for the wire shape that the SPA grid consumes. Operators
 * see every non-archived Listing in their org regardless of `listingStatus`
 * (draft/active) or `visibilityMode`. RBAC is enforced at the route layer
 * (editor+).
 *
 * Pending agent submissions are physically NOT in the Listing table after
 * the three-table refactor — they live in UnitSubmission — so the explorer
 * cannot leak them by construction. The pre-refactor EXCLUDE filter is
 * gone (no-op).
 *
 * Per-agent visibility filters (RESTRICTED grants, hiddenFromPartyIds) are
 * intentionally NOT applied at this admin endpoint.
 */
function toNumber(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

const EXPLORER_SELECT = {
  id: true,
  organizationId: true,
  listingType: true,
  listingStatus: true,
  occupancyStatus: true,
  visibilityMode: true,
  hiddenFromPartyIds: true,
  rentalRate: true,
  currency: true,
  depositMonths: true,
  utilitiesDepositMonths: true,
  accessCardDepositPerPcs: true,
  accessCardQuantity: true,
  parkingQuantity: true,
  parkingNumbers: true,
  moveInDate: true,
  readyNow: true,
  vacantSince: true,
  inChargeName: true,
  inChargePartyId: true,
  sourcingAgentId: true,
  createdAt: true,
  inChargeParty: { select: { displayName: true } },
  sourcingAgent: { select: { displayName: true } },
  photoKeys: true,
  coverPhotoKey: true,
  videoKeys: true,
  apartment: {
    select: {
      id: true,
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
      publishedTitle: true,
      publishedDescription: true,
      property: { select: { name: true, city: true } },
    },
  },
  tenancies: {
    where: { status: "active" },
    orderBy: { startDate: "desc" } as const,
    take: 1,
    select: { startDate: true, endDate: true },
  },
} as const;

type ExplorerRow = Prisma.ListingGetPayload<{ select: typeof EXPLORER_SELECT }>;

function shapeExplorerRow(row: ExplorerRow, amenityCatalog: Map<string, string>) {
  const apt = row.apartment;
  const amenityIds = apt.amenities;
  const amenities = amenityIds
    .map((id) => {
      const name = amenityCatalog.get(id);
      return name ? { id, name } : null;
    })
    .filter((x): x is { id: string; name: string } => x !== null);

  return {
    id: row.id,
    unitCode: apt.unitCode,
    // wire-compat: clients still read `unitType` at the top level.
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
    rentalRate: toNumber(row.rentalRate),
    currency: row.currency,
    depositMonths: toNumber(row.depositMonths),
    utilitiesDepositMonths: toNumber(row.utilitiesDepositMonths),
    accessCardDepositPerPcs: toNumber(row.accessCardDepositPerPcs),
    accessCardQuantity: row.accessCardQuantity,
    parkingQuantity: row.parkingQuantity,
    parkingNumbers: row.parkingNumbers,
    moveInDate: row.moveInDate,
    readyNow: row.readyNow,
    occupancyStatus: row.occupancyStatus,
    listingStatus: row.listingStatus,
    visibilityMode: row.visibilityMode,
    hiddenFromPartyIds: row.hiddenFromPartyIds,
    // Prefer the joined Party.displayName (canonical when admin used the
    // in-charge typeahead) and fall back to the legacy free-text column
    // for old rows that predate the typeahead.
    inChargeName: row.inChargeParty?.displayName ?? row.inChargeName ?? null,
    inChargePartyId: row.inChargePartyId,
    // Derived wire-compat fields. TODO: drop in Phase C.
    sourceFlag: row.sourcingAgentId ? "AGENT_SOURCED" : "COMPANY",
    sourcingAgentId: row.sourcingAgentId,
    sourcingAgentName: row.sourcingAgent?.displayName ?? null,
    sourcingApproved: true,
    vacantSince: row.vacantSince?.toISOString() ?? null,
    currentTenancyStartDate: row.tenancies[0]?.startDate?.toISOString() ?? null,
    currentTenancyEndDate: row.tenancies[0]?.endDate?.toISOString() ?? null,
    createdAt: row.createdAt,
    amenities,
    property: apt.property
      ? { name: apt.property.name, city: apt.property.city ?? null }
      : null,
  };
}

export async function listExplorerUnits(orgId: string) {
  // Temporary perf instrumentation (2026-05-20): emit a single structured JSON
  // line per request so we can see where the inventory page's latency actually
  // goes. Remove after we've decided whether to cache signed URLs.
  // Grep Lightsail logs for: `scope":"perf","op":"listExplorerUnits`
  const tStart = performance.now();

  const [rows, amenityRows] = await Promise.all([
    getDb().listing.findMany({
      where: { organizationId: orgId },
      select: EXPLORER_SELECT,
      orderBy: { createdAt: "desc" },
    }),
    getDb().amenity.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    }),
  ]);
  const tAfterDb = performance.now();

  const amenityCatalog = new Map<string, string>(amenityRows.map((a) => [a.id, a.name]));
  const shaped = rows.map((row) => shapeExplorerRow(row, amenityCatalog));

  // Sign each listing's first photoKey as a small thumbnail so the
  // explorer grid can render a cover image without per-card round-trips.
  const withCovers = await Promise.all(
    shaped.map(async (u) => {
      const firstKey = u.photoKeys[0];
      if (!firstKey) return { ...u, coverPhotoUrl: null as string | null };
      try {
        const coverPhotoUrl = await createSignedDownloadUrl(firstKey, {
          transform: { width: 400, height: 300, resize: "cover" },
        });
        return { ...u, coverPhotoUrl };
      } catch {
        return { ...u, coverPhotoUrl: null as string | null };
      }
    }),
  );
  const tEnd = performance.now();

  const signCount = shaped.filter((u) => u.photoKeys[0]).length;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      scope: "perf",
      op: "listExplorerUnits",
      orgId,
      rowCount: rows.length,
      signCount,
      dbMs: Math.round(tAfterDb - tStart),
      signMs: Math.round(tEnd - tAfterDb),
      totalMs: Math.round(tEnd - tStart),
    }),
  );

  return withCovers;
}
