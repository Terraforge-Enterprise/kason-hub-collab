// Tenant Tracker (M1) — org-scoped repository.
// Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 2).
//
// GROUPING (decided 2026-06-12): the page groups by APARTMENT (the real-world
// unit, e.g. "A-10-3A"); rooms are Listings. Pagination pages APARTMENTS on a
// composite cursor (property.name, apartment.unitCode, apartment.id) so a
// unit's rooms never split across pages.
//
// Every query in this file is org-scoped (`organizationId` in the WHERE).
// Decimals convert to number at the repo edge (tenancy.repository convention).
// NOTE: tenantParty.idNumber IS selected here — masking happens in the
// service; this select must never leak through a route without the service.

import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import {
  normalizeMyPhone,
  type ElectricityStatus,
  type TrackerLookupHit,
  type TrackerSummaryResponse,
} from "@kason/shared";
import type {
  TrackerApartmentRow,
  TrackerCarparkRow,
  TrackerCursor,
  TrackerFilters,
  TrackerPage,
} from "./types";

/** Either the root client or a transaction client (document-templates convention). */
type DbClient = Prisma.TransactionClient | ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Select consts
// ---------------------------------------------------------------------------

export const TRACKER_TENANCY_SELECT = {
  id: true,
  status: true,
  startDate: true,
  endDate: true,
  termMonths: true,
  previousTenancyId: true,
  monthlyRentAmount: true,
  numberOfPax: true,
  agentLabel: true,
  accessCardNo: true,
  previousTenancy: { select: { id: true, termMonths: true } },
  tenantParty: {
    select: {
      id: true,
      displayName: true,
      primaryPhone: true,
      primaryEmail: true,
      gender: true,
      idType: true,
      idNumber: true,
    },
  },
} as const satisfies Prisma.TenancySelect;

export const TRACKER_LISTING_SELECT = {
  id: true,
  listingType: true,
  occupancyStatus: true,
  baseRentAmount: true,
  rentalRate: true,
  accessCardQuantity: true,
  parkingNumbers: true,
  inChargePartyId: true,
  inChargeName: true,
  updatedAt: true,
  inChargeParty: { select: { id: true, displayName: true } },
} as const satisfies Prisma.ListingSelect;

/**
 * Apartment-rooted select. The per-listing tenancies are scoped by the list
 * query's `status` ONLY (never narrowed by agent/q/phone — when a phone search
 * lands on a unit, the card must still show the whole unit's rooms).
 */
export function buildTrackerApartmentSelect(status: TrackerFilters["status"]) {
  return {
    id: true,
    unitCode: true,
    floor: true,
    bedrooms: true,
    property: { select: { id: true, name: true, propertyCode: true } },
    listings: {
      select: {
        ...TRACKER_LISTING_SELECT,
        tenancies: {
          where: tenancyStatusWhere(status),
          select: TRACKER_TENANCY_SELECT,
          orderBy: [{ startDate: "desc" as const }, { id: "asc" as const }],
        },
        _count: { select: { tenancies: { where: { status: "active" } } } },
      },
      orderBy: [{ listingType: "asc" as const }, { id: "asc" as const }],
    },
  } satisfies Prisma.ApartmentSelect;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * `status` semantics (Tenancy.status is an open String with a live third
 * value "terminated"): active → `=== "active"`; ended → `!== "active"`
 * (catches "terminated"); all → no condition.
 */
export function tenancyStatusWhere(status: TrackerFilters["status"]): Prisma.TenancyWhereInput {
  if (status === "active") return { status: "active" };
  if (status === "ended") return { status: { not: "active" } };
  return {};
}

/**
 * Party-phone WHERE for tracker search (spec 2026-06-12 §3.1). Matches BOTH
 * the canonicalized form and the raw stripped digits when they differ:
 * normalizeMyPhone prepends "60" to digit strings not starting "0"/"60", so a
 * 9-digit FRAGMENT of an 011/015 number can be reinterpreted as a full 01X
 * number and silently match nothing. Returns null when no digits remain.
 */
export function buildPhoneMatchWhere(
  raw: string,
  op: "contains" | "endsWith",
): Prisma.PartyWhereInput | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const canonical = normalizeMyPhone(raw);
  if (canonical && canonical !== digits) {
    return { OR: [{ primaryPhone: { [op]: canonical } }, { primaryPhone: { [op]: digits } }] };
  }
  return { primaryPhone: { [op]: canonical ?? digits } };
}

export function encodeTrackerCursor(cursor: TrackerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null for malformed input (treated as first page by the caller). */
export function decodeTrackerCursor(raw: string): TrackerCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.propertyName !== "string" ||
      typeof candidate.unitCode !== "string" ||
      typeof candidate.apartmentId !== "string"
    ) {
      return null;
    }
    return {
      propertyName: candidate.propertyName,
      unitCode: candidate.unitCode,
      apartmentId: candidate.apartmentId,
    };
  } catch {
    return null;
  }
}

/**
 * Strictly-after tuple comparison for the (property.name, unitCode, id)
 * composite cursor: (name > X) OR (name = X AND unitCode > Y) OR
 * (name = X AND unitCode = Y AND id > Z).
 */
export function buildCursorWhere(cursor: TrackerCursor): Prisma.ApartmentWhereInput {
  return {
    OR: [
      { property: { name: { gt: cursor.propertyName } } },
      {
        property: { name: cursor.propertyName },
        unitCode: { gt: cursor.unitCode },
      },
      {
        property: { name: cursor.propertyName },
        unitCode: cursor.unitCode,
        id: { gt: cursor.apartmentId },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Decimal conversion at the repo edge
// ---------------------------------------------------------------------------

function decToNumber(value: Prisma.Decimal): number;
function decToNumber(value: Prisma.Decimal | null): number | null;
function decToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

type ApartmentQueryRow = Prisma.ApartmentGetPayload<{
  select: ReturnType<typeof buildTrackerApartmentSelect>;
}>;

function mapApartmentRow(row: ApartmentQueryRow): TrackerApartmentRow {
  return {
    id: row.id,
    unitCode: row.unitCode,
    floor: row.floor,
    bedrooms: row.bedrooms,
    property: row.property,
    listings: row.listings.map((listing) => ({
      id: listing.id,
      listingType: listing.listingType,
      occupancyStatus: listing.occupancyStatus,
      baseRentAmount: decToNumber(listing.baseRentAmount),
      rentalRate: decToNumber(listing.rentalRate),
      accessCardQuantity: listing.accessCardQuantity,
      parkingNumbers: listing.parkingNumbers,
      inChargePartyId: listing.inChargePartyId,
      inChargeName: listing.inChargeName,
      updatedAt: listing.updatedAt,
      inChargeParty: listing.inChargeParty,
      activeTenancyCount: listing._count.tenancies,
      tenancies: listing.tenancies.map((tenancy) => ({
        id: tenancy.id,
        status: tenancy.status,
        startDate: tenancy.startDate,
        endDate: tenancy.endDate,
        termMonths: tenancy.termMonths,
        previousTenancyId: tenancy.previousTenancyId,
        monthlyRentAmount: decToNumber(tenancy.monthlyRentAmount),
        numberOfPax: tenancy.numberOfPax,
        agentLabel: tenancy.agentLabel,
        accessCardNo: tenancy.accessCardNo,
        previousTenancy: tenancy.previousTenancy,
        tenantParty: tenancy.tenantParty,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Finders (orgId-first, per apartment.repository convention)
// ---------------------------------------------------------------------------

/**
 * Paged, apartment-grouped tracker read.
 *
 * UNIT-LIST SEMANTICS: when ANY tenancy-targeting filter (agent/q/phone) is
 * set, only apartments containing ≥1 matching tenancy (within the `status`
 * scope) are returned. When none is set, ALL org apartments (per
 * propertyId/roomType) are returned, occupied or not — an empty unit still
 * renders (vacant rooms are actionable: PIC assign, add charge).
 */
export async function findApartmentsForTracker(
  orgId: string,
  filters: TrackerFilters,
  cursor: string | null,
  limit: number,
): Promise<TrackerPage> {
  const conditions: Prisma.ApartmentWhereInput[] = [{ organizationId: orgId }];

  if (filters.propertyId) {
    conditions.push({ propertyId: filters.propertyId });
  }
  if (filters.roomType) {
    conditions.push({ listings: { some: { listingType: filters.roomType } } });
  }

  // "Hide vacant units" — ALWAYS-ACTIVE occupancy on room listings, independent
  // of filters.status and of tenancy-targeting filters (pushed unconditionally;
  // redundancy under AND is harmless). Spec 2026-06-12 §3.0/§3.3.
  // All Listings are rooms post-carpark-redesign; no ROOM_SCOPE filter needed.
  if (filters.occupiedOnly) {
    conditions.push({
      listings: { some: { tenancies: { some: { status: "active" } } } },
    });
  }

  // Tenancy-targeting filters — scoped by `status` AND the filter itself.
  // When agent+q+phone are combined they must all match the SAME tenancy
  // (a single `some: { AND: [...] }`) by design — not merely the same
  // apartment. Do not split these into separate `some` clauses.
  const tenancyConditions: Prisma.TenancyWhereInput[] = [];
  if (filters.agent) {
    tenancyConditions.push({ agentLabel: filters.agent }); // exact raw match (O2)
  }
  if (filters.q) {
    tenancyConditions.push({
      tenantParty: { displayName: { contains: filters.q, mode: "insensitive" } },
    });
  }
  if (filters.phone) {
    const phoneWhere = buildPhoneMatchWhere(filters.phone, "contains");
    if (!phoneWhere) return { apartments: [], nextCursor: null }; // nothing can match
    tenancyConditions.push({ tenantParty: phoneWhere });
  }
  if (tenancyConditions.length > 0) {
    conditions.push({
      listings: {
        some: {
          tenancies: { some: { AND: [tenancyStatusWhere(filters.status), ...tenancyConditions] } },
        },
      },
    });
  }

  const decodedCursor = cursor ? decodeTrackerCursor(cursor) : null;
  if (decodedCursor) {
    conditions.push(buildCursorWhere(decodedCursor));
  }

  const rows = await getDb().apartment.findMany({
    where: { AND: conditions },
    select: buildTrackerApartmentSelect(filters.status),
    orderBy: [{ property: { name: "asc" } }, { unitCode: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const apartments = (hasMore ? rows.slice(0, limit) : rows).map(mapApartmentRow);
  const last = apartments[apartments.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTrackerCursor({
          propertyName: last.property.name,
          unitCode: last.unitCode,
          apartmentId: last.id,
        })
      : null;

  return { apartments, nextCursor };
}

const LOOKUP_SELECT = {
  id: true,
  unitId: true,
  propertyId: true,
  tenantParty: { select: { displayName: true } },
  unit: { select: { apartmentId: true, apartment: { select: { unitCode: true } } } },
} as const satisfies Prisma.TenancySelect;

type LookupRow = Prisma.TenancyGetPayload<{ select: typeof LOOKUP_SELECT }>;

const toLookupHit = (row: LookupRow): TrackerLookupHit => ({
  tenancyId: row.id,
  unitId: row.unitId,
  apartmentId: row.unit.apartmentId,
  propertyId: row.propertyId,
  displayName: row.tenantParty.displayName,
  unitCode: row.unit.apartment.unitCode,
});

/**
 * Phone-search-to-act (⌘K). ANY tenancy status — a just-ended tenant still
 * phones in. SUFFIX matches rank first (v2 spec §3.1): a last-4 like "6011"
 * is also a carrier prefix, and under plain contains + take(10) the true
 * suffix match can be evicted by newer contains-noise. Two cheap org-scoped
 * queries; cap stays 10. Returns the suffix block first, then the fill block;
 * consumers render in array order (no re-sort).
 */
export async function lookupByPhone(orgId: string, rawPhone: string): Promise<TrackerLookupHit[]> {
  const suffixWhere = buildPhoneMatchWhere(rawPhone, "endsWith");
  if (!suffixWhere) return [];
  const containsWhere = buildPhoneMatchWhere(rawPhone, "contains")!; // same digits → non-null

  const orderBy = [{ startDate: "desc" as const }, { id: "asc" as const }];
  const suffixRows = await getDb().tenancy.findMany({
    where: { organizationId: orgId, tenantParty: suffixWhere },
    select: LOOKUP_SELECT,
    orderBy,
    take: 10,
  });

  const remaining = 10 - suffixRows.length;
  const fillRows =
    remaining > 0
      ? await getDb().tenancy.findMany({
          where: {
            organizationId: orgId,
            id: { notIn: suffixRows.map((r) => r.id) },
            tenantParty: containsWhere,
          },
          select: LOOKUP_SELECT,
          orderBy,
          take: remaining,
        })
      : [];

  return [...suffixRows, ...fillRows].map(toLookupHit);
}

/**
 * Distinct non-null Tenancy.agentLabel values, org-scoped, sorted asc.
 * RAW values — NO normalization/dedup beyond distinct ("KENDRA" vs "Kendra"
 * stay separate; O2 resolution).
 */
export async function listAgentLabels(orgId: string): Promise<string[]> {
  const rows = await getDb().tenancy.findMany({
    where: { organizationId: orgId, agentLabel: { not: null } },
    distinct: ["agentLabel"],
    select: { agentLabel: true },
    orderBy: [{ agentLabel: "asc" }],
  });
  return rows
    .map((row) => row.agentLabel)
    .filter((label): label is string => label !== null);
}

/**
 * Org-scoped 404 guard + optimistic-concurrency snapshot for the PIC PATCH.
 * Accepts a tx-or-db client — the service calls it inside $transaction.
 */
export async function findListingForInCharge(db: DbClient, orgId: string, unitId: string) {
  return db.listing.findFirst({
    where: { id: unitId, organizationId: orgId },
    select: { id: true, inChargePartyId: true, inChargeName: true, updatedAt: true },
  });
}

/**
 * The party iff it exists in the org — assignee validation AND the source of
 * the denormalized `inChargeName` in one org-scoped query; null otherwise.
 */
export async function findPartyInOrg(
  db: DbClient,
  orgId: string,
  partyId: string,
): Promise<{ id: string; displayName: string } | null> {
  return db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: { id: true, displayName: true },
  });
}

/**
 * Org-wide + per-property counts (v2 spec §3.2). Four cheap org-scoped
 * queries — Prisma groupBy cannot traverse Listing→Apartment→Property
 * (Listing has no propertyId scalar), so rooms-per-property goes through a
 * per-apartment _count + JS sum. All Listings are rooms post-carpark-redesign;
 * no ROOM_SCOPE filter needed. Counts use the always-ACTIVE occupancy
 * definition; status-filter independent by design.
 */
export async function getTrackerSummary(orgId: string): Promise<TrackerSummaryResponse> {
  const db = getDb();
  const [properties, aptGroups, aptRooms, occupancy] = await Promise.all([
    db.property.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true, propertyCode: true },
      orderBy: { name: "asc" },
    }),
    db.apartment.groupBy({
      by: ["propertyId"],
      where: { organizationId: orgId },
      _count: { _all: true },
    }),
    db.apartment.findMany({
      where: { organizationId: orgId },
      select: { propertyId: true, _count: { select: { listings: true } } },
    }),
    // One row per (property, occupied room); _count = active tenancies on it.
    db.tenancy.groupBy({
      by: ["propertyId", "unitId"],
      where: { organizationId: orgId, status: "active" },
      _count: { _all: true },
    }),
  ]);

  const apartmentsBy = new Map(aptGroups.map((g) => [g.propertyId, g._count._all]));

  const roomsBy = new Map<string, number>();
  for (const row of aptRooms) {
    roomsBy.set(row.propertyId, (roomsBy.get(row.propertyId) ?? 0) + row._count.listings);
  }

  // groupBy already collapsed to distinct (propertyId, unitId): occupied
  // rooms = row count per property; activeTenancies = sum of _count._all.
  const occupiedRoomsBy = new Map<string, number>();
  const activeTenanciesBy = new Map<string, number>();
  for (const row of occupancy) {
    occupiedRoomsBy.set(row.propertyId, (occupiedRoomsBy.get(row.propertyId) ?? 0) + 1);
    activeTenanciesBy.set(
      row.propertyId,
      (activeTenanciesBy.get(row.propertyId) ?? 0) + row._count._all,
    );
  }

  const perProperty = properties.map((p) => {
    const rooms = roomsBy.get(p.id) ?? 0;
    const occupied = occupiedRoomsBy.get(p.id) ?? 0;
    return {
      propertyId: p.id,
      name: p.name,
      propertyCode: p.propertyCode ?? null,
      apartments: apartmentsBy.get(p.id) ?? 0,
      rooms,
      activeTenancies: activeTenanciesBy.get(p.id) ?? 0,
      vacantRooms: rooms - occupied,
    };
  });

  return {
    totals: perProperty.reduce(
      (t, p) => ({
        apartments: t.apartments + p.apartments,
        rooms: t.rooms + p.rooms,
        activeTenancies: t.activeTenancies + p.activeTenancies,
        vacantRooms: t.vacantRooms + p.vacantRooms,
      }),
      { apartments: 0, rooms: 0, activeTenancies: 0, vacantRooms: 0 },
    ),
    properties: perProperty,
  };
}

/**
 * Fetch active CarparkAssignment rows for a set of apartment ids, returning a
 * Map keyed by apartmentId. Each row carries the bay label (from Carpark) and
 * the renter party name (from Tenancy.tenantParty) — the minimum needed to
 * render the "Carpark occupants" strip and per-tenant carpark chips.
 *
 * Only status="active" assignments are returned (the tracker shows live state).
 * The carpark.apartmentId scopes results to the home apartment of the bay.
 */
export async function findCarparkAssignmentsForApartments(
  orgId: string,
  apartmentIds: string[],
): Promise<Map<string, TrackerCarparkRow[]>> {
  if (apartmentIds.length === 0) return new Map();
  const assignments = await getDb().carparkAssignment.findMany({
    where: {
      organizationId: orgId,
      carpark: { apartmentId: { in: apartmentIds } },
      status: "active",
    },
    select: {
      id: true,
      tenancyId: true,
      status: true,
      carpark: { select: { id: true, apartmentId: true, label: true } },
      tenancy: { select: { tenantParty: { select: { id: true, displayName: true } } } },
    },
  });

  const byApt = new Map<string, TrackerCarparkRow[]>();
  for (const aptId of apartmentIds) byApt.set(aptId, []);
  for (const a of assignments) {
    const aptId = a.carpark.apartmentId;
    const list = byApt.get(aptId) ?? [];
    list.push(a as TrackerCarparkRow);
    byApt.set(aptId, list);
  }
  return byApt;
}

/**
 * Fetch the current-period electricity reading for each of the given unit ids
 * (Listing ids). Returns a Map keyed by unitId. Readings with status "void"
 * are excluded; units with no reading for the period are omitted from the Map.
 *
 * The @@unique([organizationId, unitId, periodMonth]) constraint guarantees at
 * most one row per unit per period, so findMany → Map is always 1:1.
 */
export async function findCurrentPeriodElectricity(
  orgId: string,
  unitIds: string[],
  periodMonth: Date,
): Promise<Map<string, ElectricityStatus>> {
  if (unitIds.length === 0) return new Map();
  const rows = await getDb().meterReading.findMany({
    where: {
      organizationId: orgId,
      unitId: { in: unitIds },
      periodMonth,
      status: { not: "void" },
    },
    select: {
      id: true,
      unitId: true,
      status: true,
      consumption: true,
      computedAmount: true,
    },
  });
  return new Map(
    rows.map((r) => [
      r.unitId,
      {
        readingId: r.id,
        status: r.status === "charged" ? "charged" : "submitted",
        kwh: Number(r.consumption),
        amount: Number(r.computedAmount),
      } satisfies ElectricityStatus,
    ]),
  );
}
