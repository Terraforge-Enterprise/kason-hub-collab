import { describe, it, expect } from "vitest";
import { sortUnits } from "../../logic/sort-units";
import type { InventoryListing, SortKey } from "../../domain/types";

const mk = (over: Partial<InventoryListing> & { id: string }): InventoryListing => ({
  unitCode: "A", unitType: "condo", bedrooms: 1, bathrooms: 1, floorArea: 500,
  rentalRate: "1000", moveInDate: null, readyNow: false, occupancyStatus: "occupied",
  inChargeName: null, inChargePartyId: null, photoKeys: [], videoKeys: [], coverPhotoUrl: null,
  visibilityMode: "PUBLIC", hiddenFromPartyIds: [], sourceFlag: "COMPANY",
  sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  currency: "MYR", title: null, description: null, amenities: [],
  furnishingLevel: null, floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null, listingStatus: "active",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "X", city: "KL" }, ...over,
});

const ids = (units: InventoryListing[]) => units.map(u => u.id);

describe("sortUnits", () => {
  it("ready: ready-now units first, then by id stable", () => {
    const a = mk({ id: "a", readyNow: false });
    const b = mk({ id: "b", readyNow: true });
    const c = mk({ id: "c", readyNow: true });
    expect(ids(sortUnits([a, b, c], "ready"))).toEqual(["b", "c", "a"]);
  });

  it("price-asc: lowest rental first, nulls last", () => {
    const a = mk({ id: "a", rentalRate: "2000" });
    const b = mk({ id: "b", rentalRate: "1000" });
    const c = mk({ id: "c", rentalRate: null });
    expect(ids(sortUnits([a, b, c], "price-asc"))).toEqual(["b", "a", "c"]);
  });

  it("price-desc: highest first, nulls last", () => {
    const a = mk({ id: "a", rentalRate: "1000" });
    const b = mk({ id: "b", rentalRate: "3000" });
    const c = mk({ id: "c", rentalRate: null });
    expect(ids(sortUnits([a, b, c], "price-desc"))).toEqual(["b", "a", "c"]);
  });

  it("sqft-desc: largest first, nulls last", () => {
    const a = mk({ id: "a", floorArea: 800 });
    const b = mk({ id: "b", floorArea: 1500 });
    const c = mk({ id: "c", floorArea: null });
    expect(ids(sortUnits([a, b, c], "sqft-desc"))).toEqual(["b", "a", "c"]);
  });

  it("newest: most recent createdAt first", () => {
    const a = mk({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = mk({ id: "b", createdAt: "2026-03-01T00:00:00.000Z" });
    const c = mk({ id: "c", createdAt: "2026-02-01T00:00:00.000Z" });
    expect(ids(sortUnits([a, b, c], "newest"))).toEqual(["b", "c", "a"]);
  });

  it("beds-desc: most beds first, nulls last", () => {
    const a = mk({ id: "a", bedrooms: 1 });
    const b = mk({ id: "b", bedrooms: 4 });
    const c = mk({ id: "c", bedrooms: null });
    expect(ids(sortUnits([a, b, c], "beds-desc"))).toEqual(["b", "a", "c"]);
  });

  it("does not mutate input", () => {
    const input = [mk({ id: "a", rentalRate: "3000" }), mk({ id: "b", rentalRate: "1000" })];
    const before = ids(input);
    sortUnits(input, "price-asc" satisfies SortKey);
    expect(ids(input)).toEqual(before);
  });
});
