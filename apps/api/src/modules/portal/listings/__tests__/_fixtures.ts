import type { PortalListingRow } from "../portal.listings.repository";

type Apartment = PortalListingRow["apartment"];

// Minimal stub for a Listing row returned by the Prisma mock. Only the
// fields that the mapper actually touches are needed — the rest spread
// through as-is.
//
// The new three-table model puts apartment-shared physical fields (bedrooms,
// amenities, ...) on the joined `apartment` object; per-room media
// (photoKeys / videoKeys / coverPhotoKey) lives on the Listing itself per
// spec 2026-05-24. Tests that override apartment-shared fields should pass
// them under `apartment` — e.g. `makeListingRow({ apartment: { bedrooms: 3 } })`.
// Tests that override media should pass photoKeys / videoKeys / coverPhotoKey
// at the top level.
export function makeListingRow(
  overrides: Partial<Omit<PortalListingRow, "apartment">> & {
    apartment?: Partial<Apartment>;
  } = {},
): PortalListingRow {
  const { apartment: aptOverrides, ...rowOverrides } = overrides;
  const baseApartment: Apartment = {
    id: "apt-1",
    propertyId: "prop-1",
    unitCode: "U01",
    listingMode: "PARTITIONED",
    bedrooms: 2,
    bathrooms: null,
    floorArea: null,
    floor: null,
    facing: null,
    furnishingLevel: null,
    amenities: [],
    highlights: [],
    publishedDescription: null,
    publishedTitle: null,
    property: { name: "Test Property", city: "KL", propertyCode: "TP-01" },
  };
  return {
    id: "unit-1",
    listingType: "APARTMENT",
    rentalRate: null,
    currency: "MYR",
    moveInDate: null,
    readyNow: false,
    occupancyStatus: "vacant",
    inChargeName: null,
    inChargePartyId: null,
    inChargeParty: null,
    depositMonths: null,
    utilitiesDepositMonths: null,
    accessCardDepositPerPcs: null,
    accessCardQuantity: null,
    parkingQuantity: null,
    parkingNumbers: [],
    vacantSince: null,
    listingStatus: "active",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    sourcingAgentId: null,
    sourcingAgent: null,
    createdAt: new Date("2025-01-01"),
    photoKeys: [],
    coverPhotoKey: null,
    videoKeys: [],
    apartment: { ...baseApartment, ...aptOverrides },
    tenancies: [],
    ...rowOverrides,
  } as PortalListingRow;
}

// Back-compat alias for existing call sites — `makeUnitRow` was the
// pre-refactor name when the wire row was assembled from a single Unit
// row. The new shape pulls apartment-shared fields from `apartment`; the
// alias keeps the test surface stable while the migration lands.
export const makeUnitRow = makeListingRow;
