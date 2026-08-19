import { getDb, Prisma } from "@kason/db";
import type { ListListingsQuery, ListingRow } from "./listings.types";
import { resolveRoomTypeKind } from "../inventory/listing-mode";

function toNumber(value: { toString(): string } | string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

// Columns selected for list/fetch endpoints. Listing scalars (including
// media — see spec 2026-05-24) + an Apartment include for shared
// physical-unit fields (amenities, bedrooms, …).
//
// Specs: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md
//        docs/superpowers/specs/2026-05-24-per-room-unit-media-design.md
export const LISTING_SELECT = {
  id: true,
  organizationId: true,
  apartmentId: true,
  listingType: true,
  listingStatus: true,
  baseRentAmount: true,
  currency: true,
  rentalRate: true,
  depositMonths: true,
  utilitiesDepositMonths: true,
  accessCardDepositPerPcs: true,
  accessCardQuantity: true,
  parkingQuantity: true,
  parkingNumbers: true,
  occupancyStatus: true,
  vacantSince: true,
  moveInDate: true,
  readyNow: true,
  visibilityMode: true,
  hiddenFromPartyIds: true,
  inChargeName: true,
  inChargePartyId: true,
  sourcingAgentId: true,
  salesUnitOriginId: true,
  photoKeys: true,
  coverPhotoKey: true,
  videoKeys: true,
  createdAt: true,
  updatedAt: true,
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
      property: { select: { id: true, name: true, propertyCode: true } },
    },
  },
} as const;

type ListingWithApartment = Prisma.ListingGetPayload<{ select: typeof LISTING_SELECT }>;

function mapRow(row: ListingWithApartment): ListingRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.apartment.propertyId,
    propertyName: row.apartment.property.name,
    propertyCode: row.apartment.property.propertyCode,
    unitCode: row.apartment.unitCode,
    // wire-compat: legacy clients still read `unitType` at the top level.
    unitType: row.listingType,
    listingType: row.listingType,
    occupancyStatus: row.occupancyStatus,
    listingStatus: row.listingStatus,
    currency: row.currency,
    bedrooms: row.apartment.bedrooms,
    bathrooms: toNumber(row.apartment.bathrooms),
    floorArea: toNumber(row.apartment.floorArea),
    rentalRate: toNumber(row.rentalRate),
    photoKeys: row.photoKeys,
    coverPhotoKey: row.coverPhotoKey,
    videoKeys: row.videoKeys,
    amenities: row.apartment.amenities,
    moveInDate: row.moveInDate,
    readyNow: row.readyNow,
    inChargeName: row.inChargeName,
    inChargePartyId: row.inChargePartyId,
    sourcingAgentId: row.sourcingAgentId,
    visibilityMode: row.visibilityMode,
    hiddenFromPartyIds: row.hiddenFromPartyIds,
    // Derived wire-compat fields. Every Listing is approved by definition
    // (pending submissions live in UnitSubmission). TODO: drop in Phase C.
    sourceFlag: row.sourcingAgentId ? "AGENT_SOURCED" : "COMPANY",
    sourcingApproved: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listListings(
  organizationId: string,
  filters?: ListListingsQuery,
): Promise<ListingRow[]> {
  const db = getDb();
  const q = filters?.q?.trim();
  const where: Prisma.ListingWhereInput = {
    organizationId,
    ...(filters?.status ? { occupancyStatus: filters.status } : {}),
    ...(filters?.visibilityMode ? { visibilityMode: filters.visibilityMode } : {}),
    ...(q
      ? {
          OR: [
            { apartment: { unitCode: { contains: q, mode: "insensitive" } } },
            {
              apartment: {
                property: { name: { contains: q, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };

  const rows = await db.listing.findMany({
    where,
    select: LISTING_SELECT,
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
  return rows.map(mapRow);
}

export async function findListingById(
  organizationId: string,
  id: string,
): Promise<ListingRow | null> {
  const db = getDb();
  const row = await db.listing.findFirst({
    where: { id, organizationId },
    select: LISTING_SELECT,
  });
  if (!row) return null;
  return mapRow(row);
}

export async function findPropertyById(organizationId: string, propertyId: string) {
  const db = getDb();
  return db.property.findFirst({
    where: { id: propertyId, organizationId },
    select: { id: true },
  });
}

/**
 * Conflict check for (propertyId, unitCode, listingType). The new
 * physical-storage layout puts (propertyId, unitCode) on Apartment and
 * (apartmentId, listingType) as the unique key on Listing — but the admin
 * write surface still scopes uniqueness as "no two Listings in the same
 * (org, property, unitCode, listingType)" so the API edge can keep its
 * legacy shape. This helper walks Apartment to find the existing Listing.
 *
 * Caller-supplied `unitType` matches `listingType` (wire-compat alias).
 */
export async function findUnitCodeConflict(params: {
  organizationId: string;
  propertyId: string;
  unitCode: string;
  unitType?: string;
  excludeUnitId?: string;
}) {
  const db = getDb();
  return db.listing.findFirst({
    where: {
      organizationId: params.organizationId,
      apartment: {
        propertyId: params.propertyId,
        unitCode: params.unitCode,
      },
      ...(params.unitType ? { listingType: params.unitType } : {}),
      ...(params.excludeUnitId ? { id: { not: params.excludeUnitId } } : {}),
    },
    select: { id: true },
  });
}

export type CreateListingDbInput = {
  organizationId: string;
  propertyId: string;
  unitCode: string;
  unitType: string;
  photoKeys: string[];
  videoKeys: string[];
  moveInDate?: string;
  readyNow: boolean;
  inChargeName?: string;
  inChargePartyId?: string;
  sourcingAgentId?: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  rentalRate?: number;
  bedrooms?: number;
  bathrooms?: number;
  floorArea?: number;
};

/**
 * Find-or-create the parent Apartment for a Listing write.
 *
 * Apartment-shared physical-unit fields (bedrooms, bathrooms, floorArea)
 * accepted at the API edge land on the Apartment when it's being created.
 * If the Apartment already exists, the call leaves shared fields untouched
 * — the spec defers "edit shared details" to the apartment service, not
 * the per-Listing create path.
 *
 * Media fields (photoKeys / videoKeys / coverPhotoKey) live on the Listing
 * per spec 2026-05-24 and are NOT passed through here.
 *
 * listingMode is derived from the room type's kind. Unknown kind falls
 * back to PARTITIONED (the more permissive mode — a Whole listing can
 * always be re-flipped via flipApartmentMode later).
 */
async function findOrCreateApartmentTx(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    propertyId: string;
    unitCode: string;
    listingType: string;
    bedrooms?: number;
    bathrooms?: number;
    floorArea?: number;
  },
): Promise<{ id: string }> {
  const existing = await tx.apartment.findFirst({
    where: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      unitCode: args.unitCode,
    },
    select: { id: true },
  });
  if (existing) return existing;

  const kind = await resolveRoomTypeKind(args.organizationId, args.listingType);
  const listingMode: "WHOLE" | "PARTITIONED" = kind === "WHOLE" ? "WHOLE" : "PARTITIONED";

  return tx.apartment.create({
    data: {
      organizationId: args.organizationId,
      propertyId: args.propertyId,
      unitCode: args.unitCode,
      listingMode,
      bedrooms: args.bedrooms ?? null,
      bathrooms: args.bathrooms ?? null,
      floorArea: args.floorArea ?? null,
    },
    select: { id: true },
  });
}

export async function createListingRow(
  tx: Prisma.TransactionClient,
  input: CreateListingDbInput,
): Promise<ListingRow> {
  const apt = await findOrCreateApartmentTx(tx, {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    unitCode: input.unitCode,
    listingType: input.unitType,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    floorArea: input.floorArea,
  });

  const row = await tx.listing.create({
    data: {
      organizationId: input.organizationId,
      apartmentId: apt.id,
      listingType: input.unitType,
      occupancyStatus: "vacant",
      listingStatus: "active",
      currency: "MYR",
      moveInDate: input.moveInDate ? new Date(input.moveInDate) : null,
      readyNow: input.readyNow,
      inChargeName: input.inChargeName ?? null,
      inChargePartyId: input.inChargePartyId ?? null,
      sourcingAgentId: input.sourcingAgentId ?? null,
      visibilityMode: input.visibilityMode,
      hiddenFromPartyIds: input.hiddenFromPartyIds,
      rentalRate: input.rentalRate ?? null,
      photoKeys: input.photoKeys,
      videoKeys: input.videoKeys,
    },
    select: LISTING_SELECT,
  });
  return mapRow(row);
}

export type UpdateListingDbInput = Partial<Omit<CreateListingDbInput, "organizationId">>;

export async function updateListingRow(
  tx: Prisma.TransactionClient,
  id: string,
  input: UpdateListingDbInput,
): Promise<ListingRow> {
  // Apartment-shared physical-unit fields (bedrooms, bathrooms, floorArea,
  // unitCode) are still accepted at the API edge for back-compat — route
  // them to the Apartment row attached to this Listing. Media fields
  // (photoKeys / videoKeys) live on the Listing itself per spec 2026-05-24.
  const apartmentPatch: Prisma.ApartmentUpdateInput = {};
  if (input.bedrooms !== undefined) apartmentPatch.bedrooms = input.bedrooms ?? null;
  if (input.bathrooms !== undefined) apartmentPatch.bathrooms = input.bathrooms ?? null;
  if (input.floorArea !== undefined) apartmentPatch.floorArea = input.floorArea ?? null;

  // unitCode changes only affect the Apartment (the unit-code lives there).
  if (input.unitCode !== undefined) apartmentPatch.unitCode = input.unitCode;

  if (Object.keys(apartmentPatch).length > 0) {
    // Find the listing's apartmentId in the same tx so the read+update is
    // a single snapshot.
    const current = await tx.listing.findFirst({
      where: { id },
      select: { apartmentId: true },
    });
    if (current) {
      await tx.apartment.update({
        where: { id: current.apartmentId },
        data: apartmentPatch,
      });
    }
  }

  const data: Prisma.ListingUpdateInput = {};
  if (input.unitType !== undefined) data.listingType = input.unitType;
  if (input.moveInDate !== undefined) {
    data.moveInDate = input.moveInDate ? new Date(input.moveInDate) : null;
  }
  if (input.readyNow !== undefined) data.readyNow = input.readyNow;
  if (input.inChargeName !== undefined) data.inChargeName = input.inChargeName ?? null;
  if (input.inChargePartyId !== undefined) {
    data.inChargeParty = input.inChargePartyId
      ? { connect: { id: input.inChargePartyId } }
      : { disconnect: true };
  }
  if (input.sourcingAgentId !== undefined) {
    data.sourcingAgent = input.sourcingAgentId
      ? { connect: { id: input.sourcingAgentId } }
      : { disconnect: true };
  }
  if (input.visibilityMode !== undefined) data.visibilityMode = input.visibilityMode;
  if (input.hiddenFromPartyIds !== undefined) data.hiddenFromPartyIds = input.hiddenFromPartyIds;
  if (input.rentalRate !== undefined) data.rentalRate = input.rentalRate ?? null;
  if (input.photoKeys !== undefined) data.photoKeys = input.photoKeys;
  if (input.videoKeys !== undefined) data.videoKeys = input.videoKeys;

  const row = await tx.listing.update({
    where: { id },
    data,
    select: LISTING_SELECT,
  });
  return mapRow(row);
}

// Composite-key delete kills the TOCTOU window: even if `findListingById`
// ran outside the tx (legacy flow), a row belonging to a different org
// still can't be deleted because the composite `{ id, organizationId }`
// filter will match zero rows. Returns `count` so callers can distinguish
// "nothing matched" from "deleted".
export async function deleteListingRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
): Promise<{ count: number }> {
  return tx.listing.deleteMany({ where: { id, organizationId } });
}

/**
 * Same-tx org-scoped lookup. Use this inside a `withTransaction` block
 * instead of the non-tx `findListingById` to eliminate TOCTOU gaps
 * between the ownership check and the subsequent write.
 */
export async function findListingByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
) {
  const row = await tx.listing.findFirst({
    where: { id, organizationId },
    select: LISTING_SELECT,
  });
  if (!row) return null;
  return mapRow(row);
}

// Wraps the configured PrismaClient's $transaction so the service layer can
// be mocked without pulling in the full client in tests.
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
