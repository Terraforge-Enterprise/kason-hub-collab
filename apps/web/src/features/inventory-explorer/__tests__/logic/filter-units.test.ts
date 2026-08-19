import { describe, it, expect } from "vitest";
import { filterUnits } from "../../logic/filter-units";
import { EMPTY_FILTERS, type InventoryListing } from "../../domain/types";

const TODAY = new Date("2026-05-09T00:00:00Z");

const mk = (over: Partial<InventoryListing> & { id: string }): InventoryListing => ({
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

describe("filterUnits — availability switch", () => {
  const ready = mk({ id: "r", readyNow: true, occupancyStatus: "vacant" });
  const endingSoon = mk({
    id: "e", occupancyStatus: "occupied",
    currentTenancyEndDate: new Date("2026-06-01T00:00:00Z").toISOString(),
  });
  const occupied = mk({
    id: "o", occupancyStatus: "occupied",
    currentTenancyEndDate: new Date("2027-01-01T00:00:00Z").toISOString(),
  });
  const upcoming = mk({
    id: "u", moveInDate: new Date("2026-07-01T00:00:00Z").toISOString(),
  });

  it("availability=now keeps only ready", () => {
    const out = filterUnits([ready, endingSoon, occupied, upcoming], { ...EMPTY_FILTERS, availability: "now" }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["r"]);
  });

  it("availability=occupied keeps occupied AND ending-soon (both have a current tenant)", () => {
    const out = filterUnits([ready, endingSoon, occupied, upcoming], { ...EMPTY_FILTERS, availability: "occupied" }, TODAY);
    expect(out.map((u) => u.id).sort()).toEqual(["e", "o"]);
  });

  it("availability=all keeps everything", () => {
    const out = filterUnits([ready, endingSoon, occupied, upcoming], { ...EMPTY_FILTERS, availability: "all" }, TODAY);
    expect(out.map((u) => u.id).sort()).toEqual(["e", "o", "r", "u"]);
  });
});

describe("filterUnits — new filter dimensions", () => {
  it("furnishingLevels narrows by exact match", () => {
    const fully = mk({ id: "f", furnishingLevel: "Fully" });
    const partly = mk({ id: "p", furnishingLevel: "Partially" });
    const out = filterUnits([fully, partly], { ...EMPTY_FILTERS, availability: "all", furnishingLevels: ["Fully"] }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["f"]);
  });

  it("amenities filter requires unit to contain ALL selected amenities", () => {
    const a = mk({ id: "a", amenities: [{ id: "u-pool", name: "Pool" }, { id: "u-gym", name: "Gym" }] });
    const b = mk({ id: "b", amenities: [{ id: "u-pool", name: "Pool" }] });
    const out = filterUnits([a, b], { ...EMPTY_FILTERS, availability: "all", amenities: ["u-pool", "u-gym"] }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["a"]);
  });

  it("floorMin/floorMax narrows by inclusive numeric range; null = unbounded; excludes units without a floor", () => {
    const f3 = mk({ id: "f3", floor: 3 });
    const f10 = mk({ id: "f10", floor: 10 });
    const f22 = mk({ id: "f22", floor: 22 });
    const noFloor = mk({ id: "nul", floor: null });

    const lowOnly = filterUnits([f3, f10, f22, noFloor], { ...EMPTY_FILTERS, availability: "all", floorMin: 1, floorMax: 5 }, TODAY);
    expect(lowOnly.map((u) => u.id)).toEqual(["f3"]);

    const sixPlus = filterUnits([f3, f10, f22, noFloor], { ...EMPTY_FILTERS, availability: "all", floorMin: 6, floorMax: null }, TODAY);
    expect(sixPlus.map((u) => u.id).sort()).toEqual(["f10", "f22"]);

    const upTo15 = filterUnits([f3, f10, f22, noFloor], { ...EMPTY_FILTERS, availability: "all", floorMin: null, floorMax: 15 }, TODAY);
    expect(upTo15.map((u) => u.id).sort()).toEqual(["f10", "f3"]);
  });

  it("facings filter normalizes data first letter, case-insensitive", () => {
    const n1 = mk({ id: "n1", facing: "N" });
    const n2 = mk({ id: "n2", facing: "north" });
    const ne = mk({ id: "ne", facing: "NE" });
    const s = mk({ id: "s", facing: "South" });
    const out = filterUnits([n1, n2, ne, s], { ...EMPTY_FILTERS, availability: "all", facings: ["N"] }, TODAY);
    expect(out.map((u) => u.id).sort()).toEqual(["n1", "n2", "ne"]);
  });

  it("vacantSinceMinDays excludes units vacant for fewer days", () => {
    const old = mk({ id: "old", vacantSince: new Date("2025-12-01T00:00:00Z").toISOString() });
    const recent = mk({ id: "rec", vacantSince: new Date("2026-04-15T00:00:00Z").toISOString() });
    const out = filterUnits([old, recent], { ...EMPTY_FILTERS, availability: "all", vacantSinceMinDays: 60 }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["old"]);
  });

  it("depositMonthsMax=1 keeps only units with depositMonths<=1", () => {
    const one = mk({ id: "1", depositMonths: 1 });
    const two = mk({ id: "2", depositMonths: 2 });
    const out = filterUnits([one, two], { ...EMPTY_FILTERS, availability: "all", depositMonthsMax: 1 }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["1"]);
  });

  it("sourcedByPartyIds narrows AGENT_SOURCED units", () => {
    const a = mk({ id: "a", sourceFlag: "AGENT_SOURCED", sourcingAgentId: "p1" });
    const b = mk({ id: "b", sourceFlag: "AGENT_SOURCED", sourcingAgentId: "p2" });
    const c = mk({ id: "c", sourceFlag: "COMPANY" });
    const out = filterUnits([a, b, c], { ...EMPTY_FILTERS, availability: "all", sourcedByPartyIds: ["p1"] }, TODAY);
    expect(out.map((u) => u.id)).toEqual(["a"]);
  });
});

describe("filterUnits — moveIn window filter", () => {
  it("excludes units whose moveInDate is null when range is set", () => {
    const u = mk({ id: "x", moveInDate: null });
    const out = filterUnits([u], { ...EMPTY_FILTERS, availability: "all", moveInFrom: "2026-05-09", moveInTo: "2026-06-09" }, TODAY);
    expect(out).toHaveLength(0);
  });

  it("includes units whose moveInDate is in range", () => {
    const u = mk({ id: "x", moveInDate: "2026-05-20T00:00:00Z" });
    const out = filterUnits([u], { ...EMPTY_FILTERS, availability: "all", moveInFrom: "2026-05-09", moveInTo: "2026-06-09" }, TODAY);
    expect(out.map((r) => r.id)).toEqual(["x"]);
  });

  it("excludes units whose moveInDate is before the From boundary", () => {
    const u = mk({ id: "x", moveInDate: "2026-05-10T00:00:00Z" });
    const out = filterUnits([u], { ...EMPTY_FILTERS, availability: "all", moveInFrom: "2026-05-15", moveInTo: null }, TODAY);
    expect(out).toHaveLength(0);
  });

  it("excludes units whose moveInDate is after the To boundary", () => {
    const u = mk({ id: "x", moveInDate: "2026-05-20T00:00:00Z" });
    const out = filterUnits([u], { ...EMPTY_FILTERS, availability: "all", moveInFrom: null, moveInTo: "2026-05-15" }, TODAY);
    expect(out).toHaveLength(0);
  });
});
