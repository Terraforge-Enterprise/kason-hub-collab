import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findManyParty = vi.fn();
const findManyGrant = vi.fn();
const findManyAmenity = vi.fn();
vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findUnique },
    party: { findMany: findManyParty },
    listingVisibilityGrant: { findMany: findManyGrant },
    amenity: { findMany: findManyAmenity },
  }),
}));

beforeEach(() => {
  findUnique.mockReset();
  findManyParty.mockReset();
  // Default: no grants. Tests that care about grants override this with
  // mockResolvedValueOnce. mockReset would wipe this default, so we
  // re-establish it here on every test.
  findManyGrant.mockReset();
  findManyGrant.mockResolvedValue([]);
  // Default: empty amenity catalog. Tests that assert the amenity wire
  // shape override with `findManyAmenity.mockResolvedValueOnce([...])`.
  findManyAmenity.mockReset();
  findManyAmenity.mockResolvedValue([]);
});

// The new Listing+Apartment join shape — used by every mock below.
type ListingMockRow = Record<string, unknown> & {
  apartment: Record<string, unknown>;
};

function listingRow(overrides: Partial<ListingMockRow> = {}): ListingMockRow {
  return {
    id: "u1",
    organizationId: "o1",
    apartmentId: "apt-1",
    listingType: "Master",
    currency: "MYR",
    occupancyStatus: "vacant",
    listingStatus: "draft",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    rentalRate: { toString: () => "1800.00" },
    sourcingAgentId: null,
    inChargePartyId: null,
    inChargeName: null,
    inChargeParty: null,
    ownerParty: null,
    photoKeys: [],
    videoKeys: [],
    moveInDate: null,
    readyNow: false,
    depositMonths: null,
    utilitiesDepositMonths: null,
    accessCardDepositPerPcs: null,
    accessCardQuantity: null,
    parkingQuantity: null,
    parkingNumbers: [],
    tenancies: [],
    apartment: {
      unitCode: "A-12-05",
      bedrooms: 1,
      bathrooms: { toString: () => "1.0" },
      floor: null,
      floorArea: { toString: () => "180.00" },
      amenities: [],
      highlights: [],
      publishedDescription: null,
      photoKeys: [],
      videoKeys: [],
      property: {
        id: "prop1",
        name: "Vertu Resort",
        propertyCode: "VTRU",
        city: "Kuala Lumpur",
        hasPaxDeduction: false,
        paxDeductionAmount: null,
      },
    },
    ...overrides,
  };
}

describe("findUnitDetail", () => {
  it("returns null when the listing is not found", async () => {
    findUnique.mockResolvedValueOnce(null);
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "11111111-1111-1111-1111-111111111111");
    expect(r).toBeNull();
  });

  it("returns null when the listing belongs to a different org", async () => {
    findUnique.mockResolvedValueOnce(listingRow({ organizationId: "o2" }));
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "u1");
    expect(r).toBeNull();
  });

  it("resolves hiddenFromPartyIds to agent names", async () => {
    findUnique.mockResolvedValueOnce(
      listingRow({
        visibilityMode: "RESTRICTED",
        hiddenFromPartyIds: ["p1", "p2"],
        readyNow: true,
        inChargePartyId: "p3",
        inChargeParty: { id: "p3", displayName: "Aisha Rahman" },
        apartment: {
          unitCode: "A-12-05",
          bedrooms: 1,
          bathrooms: { toString: () => "1.0" },
          floor: null,
          floorArea: { toString: () => "180.00" },
          amenities: ["WiFi"],
          highlights: [],
          publishedDescription: "Quiet master room",
          photoKeys: ["units/u1/abc.jpg"],
          videoKeys: [],
          property: {
            id: "prop1",
            name: "Vertu Resort",
            propertyCode: "VTRU",
            city: "Kuala Lumpur",
            hasPaxDeduction: false,
            paxDeductionAmount: null,
          },
        },
      }),
    );
    findManyParty.mockResolvedValueOnce([
      { id: "p1", displayName: "Mazda" },
      { id: "p2", displayName: "Honda" },
    ]);
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "u1");
    expect(r).not.toBeNull();
    expect(r!.hiddenFromAgentNames).toEqual(["Mazda", "Honda"]);
    expect(r!.inChargeName).toBe("Aisha Rahman");
    expect(r!.property?.name).toBe("Vertu Resort");
    expect(r!.description).toBe("Quiet master room");
  });

  it("returns empty hiddenFromAgentNames when hiddenFromPartyIds is empty", async () => {
    findUnique.mockResolvedValueOnce(
      listingRow({
        apartment: {
          unitCode: "A-12-05",
          bedrooms: 1,
          bathrooms: { toString: () => "1.0" },
          floor: null,
          floorArea: { toString: () => "180.00" },
          amenities: [],
          highlights: [],
          publishedDescription: null,
          photoKeys: [],
          videoKeys: [],
          property: {
            id: "prop1",
            name: "Vertu",
            propertyCode: "VTRU",
            city: null,
            hasPaxDeduction: true,
            paxDeductionAmount: { toString: () => "50.00" },
          },
        },
      }),
    );
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "u1");
    expect(r!.hiddenFromAgentNames).toEqual([]);
    expect(findManyParty).not.toHaveBeenCalled();
  });

  it("returns amenities as {id, name}[] using the org catalog (kill parallel mapper)", async () => {
    findUnique.mockResolvedValueOnce(
      listingRow({
        readyNow: true,
        apartment: {
          unitCode: "A-1",
          bedrooms: 1,
          bathrooms: { toString: () => "1.0" },
          floor: null,
          floorArea: { toString: () => "180.00" },
          amenities: ["a1", "a2"],
          highlights: [],
          publishedDescription: null,
          photoKeys: [],
          videoKeys: [],
          property: {
            id: "prop1",
            name: "X",
            propertyCode: "X",
            city: "KL",
            hasPaxDeduction: false,
            paxDeductionAmount: null,
          },
        },
      }),
    );
    findManyAmenity.mockResolvedValueOnce([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "u1");
    expect(r?.amenities).toEqual([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
  });

  it("returns owner name and phone from ownerParty", async () => {
    findUnique.mockResolvedValue(
      listingRow({
        ownerPartyId: "owner-1",
        ownerParty: { displayName: "DATO RAZAK", primaryPhone: "+60 12-345 6789" },
      }),
    );
    const { findUnitDetail } = await import("../inventory.repository");
    const detail = await findUnitDetail("o1", "u1");
    expect(detail?.ownerName).toBe("DATO RAZAK");
    expect(detail?.ownerPhone).toBe("+60 12-345 6789");
  });

  it("filters out amenity IDs missing from the catalog (hard-deleted)", async () => {
    findUnique.mockResolvedValueOnce(
      listingRow({
        readyNow: true,
        apartment: {
          unitCode: "A-1",
          bedrooms: 1,
          bathrooms: { toString: () => "1.0" },
          floor: null,
          floorArea: { toString: () => "180.00" },
          amenities: ["a1", "a-orphan"],
          highlights: [],
          publishedDescription: null,
          photoKeys: [],
          videoKeys: [],
          property: {
            id: "prop1",
            name: "X",
            propertyCode: "X",
            city: "KL",
            hasPaxDeduction: false,
            paxDeductionAmount: null,
          },
        },
      }),
    );
    findManyAmenity.mockResolvedValueOnce([{ id: "a1", name: "Gym" }]);
    const { findUnitDetail } = await import("../inventory.repository");
    const r = await findUnitDetail("o1", "u1");
    expect(r?.amenities).toEqual([{ id: "a1", name: "Gym" }]);
  });
});
