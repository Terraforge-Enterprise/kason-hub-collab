import { describe, it, expect } from "vitest";
import { computeFilterCardinality } from "../../hooks/use-filter-cardinality";
import { type InventoryListing } from "../../domain/types";

const mk = (over: Partial<InventoryListing>): InventoryListing => ({
  id: Math.random().toString(36),
  unitCode: "A", unitType: "condo", bedrooms: 1, bathrooms: 1, floorArea: 500,
  rentalRate: "1000", moveInDate: null, readyNow: false, occupancyStatus: "occupied",
  inChargeName: null, inChargePartyId: null, photoKeys: [], videoKeys: [], coverPhotoUrl: null,
  visibilityMode: "PUBLIC", hiddenFromPartyIds: [], sourceFlag: "COMPANY",
  sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z", currency: "MYR",
  title: null, description: null, amenities: [],
  furnishingLevel: null, floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null, listingStatus: "active",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "X", city: "KL" }, ...over,
});

describe("computeFilterCardinality", () => {
  it("returns sorted distinct values for each dimension", () => {
    const c = computeFilterCardinality([
      mk({ unitType: "condo", property: { name: "B1", city: "KL" } }),
      mk({ unitType: "studio", property: { name: "B2", city: "Klang" } }),
      mk({ unitType: "condo", property: { name: "B1", city: "KL" } }),
    ]);
    expect(c.unitTypes).toEqual(["condo", "studio"]);
    expect(c.cities).toEqual(["KL", "Klang"]);
    expect(c.buildings).toEqual(["B1", "B2"]);
  });

  it("inChargeAgents pairs id+name and sorts by name", () => {
    const c = computeFilterCardinality([
      mk({ inChargePartyId: "p2", inChargeName: "Zane" }),
      mk({ inChargePartyId: "p1", inChargeName: "Ahmad" }),
      mk({ inChargePartyId: "p1", inChargeName: "Ahmad" }),
    ]);
    expect(c.inChargeAgents).toEqual([
      { id: "p1", name: "Ahmad" },
      { id: "p2", name: "Zane" },
    ]);
  });

  it("sourcingAgents pulls from sourcingAgentId+sourcingAgentName", () => {
    const c = computeFilterCardinality([
      mk({ sourcingAgentId: "s1", sourcingAgentName: "Priya" }),
      mk({ sourcingAgentId: "s2", sourcingAgentName: "Wei" }),
      mk({ sourcingAgentId: null }),
    ]);
    expect(c.sourcingAgents).toEqual([
      { id: "s1", name: "Priya" },
      { id: "s2", name: "Wei" },
    ]);
  });

  it("amenities flattens and dedups", () => {
    const c = computeFilterCardinality([
      mk({ amenities: [{ id: "p", name: "Pool" }, { id: "g", name: "Gym" }] }),
      mk({ amenities: [{ id: "p", name: "Pool" }, { id: "k", name: "Parking" }] }),
    ]);
    expect(c.amenities).toEqual([
      { id: "g", name: "Gym" },
      { id: "k", name: "Parking" },
      { id: "p", name: "Pool" },
    ]);
  });

  it("facings normalize to uppercase first letter", () => {
    const c = computeFilterCardinality([
      mk({ facing: "north" }),
      mk({ facing: "S" }),
      mk({ facing: "NE" }),
    ]);
    expect(c.facings).toEqual(["N", "S"]);
  });

  it("furnishingLevels dedups (null excluded)", () => {
    const c = computeFilterCardinality([
      mk({ furnishingLevel: "Fully" }),
      mk({ furnishingLevel: "Fully" }),
      mk({ furnishingLevel: null }),
    ]);
    expect(c.furnishingLevels).toEqual(["Fully"]);
  });

  it("hasVacantSince true if any unit has it", () => {
    expect(computeFilterCardinality([mk({})]).hasVacantSince).toBe(false);
    expect(computeFilterCardinality([mk({ vacantSince: "2026-01-01T00:00:00Z" })]).hasVacantSince).toBe(true);
  });

  it("sources includes both COMPANY and AGENT_SOURCED if both present", () => {
    const c = computeFilterCardinality([
      mk({ sourceFlag: "COMPANY" }),
      mk({ sourceFlag: "AGENT_SOURCED" }),
    ]);
    expect(c.sources.sort()).toEqual(["agent_sourced", "company"]);
  });

  it("hasFloor true if any unit has floor", () => {
    expect(computeFilterCardinality([mk({})]).hasFloor).toBe(false);
    expect(computeFilterCardinality([mk({ floor: 5 })]).hasFloor).toBe(true);
  });

  it("hasDepositData true if any unit has depositMonths", () => {
    expect(computeFilterCardinality([mk({})]).hasDepositData).toBe(false);
    expect(computeFilterCardinality([mk({ depositMonths: 2 })]).hasDepositData).toBe(true);
  });
});

describe("computeFilterCardinality — amenities (catalog-driven)", () => {
  it("aggregates {id, name} pairs across units, dedupes by id", () => {
    const c = computeFilterCardinality([
      mk({ amenities: [{ id: "a1", name: "Gym" }, { id: "a2", name: "Pool" }] }),
      mk({ amenities: [{ id: "a1", name: "Gym" }] }),
    ]);
    expect(c.amenities).toEqual([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
  });

  it("sorts amenities alphabetically by name", () => {
    const c = computeFilterCardinality([
      mk({ amenities: [{ id: "a1", name: "Sauna" }, { id: "a2", name: "Gym" }] }),
    ]);
    expect(c.amenities.map((a) => a.name)).toEqual(["Gym", "Sauna"]);
  });

  it("returns empty when no units have amenities", () => {
    const c = computeFilterCardinality([mk({ amenities: [] })]);
    expect(c.amenities).toEqual([]);
  });
});

describe("computeFilterCardinality — sourcingAgents (admin/portal parity guard)", () => {
  it("drops entries missing sourcingAgentName (defensive — bug-class regression)", () => {
    // The shared backend mapper guarantees sourcingAgentName is always
    // computed, but this defensive behavior pins the contract: if a third
    // backend path ever omits the field, the agent silently disappears
    // from the sub-picker rather than crashing the cardinality hook.
    const c = computeFilterCardinality([
      mk({
        sourceFlag: "AGENT_SOURCED",
        sourcingAgentId: "agent-99",
        sourcingAgentName: null,
      }),
    ]);
    expect(c.sourcingAgents).toEqual([]);
  });
});
