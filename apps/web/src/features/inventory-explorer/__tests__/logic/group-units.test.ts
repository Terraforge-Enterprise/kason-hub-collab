import { describe, it, expect } from "vitest";
import { groupUnitsByBuilding } from "../../logic/group-units";
import type { InventoryListing } from "../../domain/types";

const mk = (id: string, name: string, city: string | null = "KL"): InventoryListing => ({
  id, unitCode: id, unitType: "condo", bedrooms: 1, bathrooms: 1, floorArea: 500,
  rentalRate: "1000", moveInDate: null, readyNow: true, occupancyStatus: "occupied",
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
  property: { name, city },
});

describe("groupUnitsByBuilding", () => {
  it("buckets units by property.name", () => {
    const buckets = groupUnitsByBuilding([
      mk("u1", "Bangsar South"),
      mk("u2", "PV9"),
      mk("u3", "Bangsar South"),
    ]);
    expect(buckets).toHaveLength(2);
    const bs = buckets.find(b => b.buildingName === "Bangsar South")!;
    expect(bs.units.map(u => u.id)).toEqual(["u1", "u3"]);
  });

  it("sorts buckets by unit count desc, alpha tiebreak", () => {
    const buckets = groupUnitsByBuilding([
      mk("u1", "B"), mk("u2", "B"),
      mk("u3", "A"),
      mk("u4", "C"), mk("u5", "C"),
    ]);
    expect(buckets.map(b => b.buildingName)).toEqual(["B", "C", "A"]);
  });

  it("uses 'Unknown' label when property.name is missing", () => {
    const u = mk("u1", "");
    const buckets = groupUnitsByBuilding([u]);
    expect(buckets[0].buildingName).toBe("Unknown");
  });

  it("preserves unit order within bucket", () => {
    const buckets = groupUnitsByBuilding([mk("u1", "A"), mk("u2", "A"), mk("u3", "A")]);
    expect(buckets[0].units.map(u => u.id)).toEqual(["u1", "u2", "u3"]);
  });
});
