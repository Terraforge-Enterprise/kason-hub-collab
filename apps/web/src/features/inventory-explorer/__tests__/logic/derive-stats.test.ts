import { describe, it, expect } from "vitest";
import { deriveStats } from "../../logic/derive-stats";
import type { InventoryListing } from "../../domain/types";

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

describe("deriveStats", () => {
  it("counts units, ready-now, and buildings", () => {
    const s = deriveStats([
      mk({ id: "a", readyNow: true,  property: { name: "X", city: "KL" }}),
      mk({ id: "b", readyNow: false, property: { name: "X", city: "KL" }}),
      mk({ id: "c", readyNow: true,  property: { name: "Y", city: "KL" }}),
    ]);
    expect(s.count).toBe(3);
    expect(s.readyNowCount).toBe(2);
    expect(s.buildingCount).toBe(2);
  });

  it("computes avg rental ignoring nulls, rounded to nearest int", () => {
    const s = deriveStats([
      mk({ id: "a", rentalRate: "1000" }),
      mk({ id: "b", rentalRate: "2000" }),
      mk({ id: "c", rentalRate: null }),
    ]);
    expect(s.avgRental).toBe(1500);
  });

  it("avgRental is null when no rentalRate present", () => {
    const s = deriveStats([mk({ id: "a", rentalRate: null })]);
    expect(s.avgRental).toBeNull();
  });

  it("returns zeros for empty input", () => {
    const s = deriveStats([]);
    expect(s).toEqual({ count: 0, readyNowCount: 0, buildingCount: 0, avgRental: null });
  });
});
