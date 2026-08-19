import { describe, expect, it } from "vitest";
import { flattenUnitLabel, flattenApartmentLabel } from "../service";
import { computeAllocation, type BillingMode, type PoolComponents, type RoomInput } from "../compute";

// Backend↔frontend label contract (frontend §16): the meter LIST endpoints must
// return the human label the table renders, never just the raw FK. These pure
// mappers flatten the Prisma relation include so the web row carries a flat
// apartmentUnitCode (+ listingType) instead of the nested object.
describe("flattenUnitLabel — meter/reading rows carry apartmentUnitCode + listingType", () => {
  it("flattens unit→apartment to flat label fields and drops the nested object", () => {
    const row = { id: "m1", unitId: "u1", meterNumber: "X", unit: { listingType: "room", apartment: { unitCode: "A-08-02" } } };
    const out = flattenUnitLabel(row);
    expect(out).toEqual({ id: "m1", unitId: "u1", meterNumber: "X", apartmentUnitCode: "A-08-02", listingType: "room" });
    expect("unit" in out).toBe(false);
  });
  it("is null-safe when the relation is absent", () => {
    const out = flattenUnitLabel({ id: "m1", unitId: "u1", unit: null });
    expect(out.apartmentUnitCode).toBeNull();
    expect(out.listingType).toBeNull();
  });
});

describe("flattenApartmentLabel — bill rows carry apartmentUnitCode", () => {
  it("flattens apartment.unitCode and drops the nested object", () => {
    const out = flattenApartmentLabel({ id: "b1", apartmentId: "a1", apartment: { unitCode: "A-08-02" } });
    expect(out).toEqual({ id: "b1", apartmentId: "a1", apartmentUnitCode: "A-08-02" });
    expect("apartment" in out).toBe(false);
  });
  it("is null-safe when the relation is absent", () => {
    expect(flattenApartmentLabel({ id: "b1", apartmentId: "a1", apartment: null }).apartmentUnitCode).toBeNull();
  });
});

// Preview D2 fix: the allocation/paxless rows must render the room label, not a
// truncated UUID. compute threads the display labels through to each line
// WITHOUT touching any monetary computation.
describe("compute threads display labels onto allocations (no math change)", () => {
  const mode: BillingMode = "no_subsidy";
  const subsidyPerPax = 0;
  const pool: PoolComponents = { tnbTotal: 100, airSelangor: 0, indahWater: 0, wifi: 0, cleaning: 0 , maintenance: 0};
  it("copies unitCode + listingType onto each allocation line", () => {
    const rooms: RoomInput[] = [
      { unitId: "u1", tenancyId: "t1", partyId: "p1", pax: 1, airconCharge: 0, unitCode: "A-08-02", listingType: "master" },
    ];
    const a = computeAllocation(mode, subsidyPerPax, pool, rooms).allocations[0];
    expect(a.unitCode).toBe("A-08-02");
    expect(a.listingType).toBe("master");
    expect(a.computedAmount).toBe(100); // single pax gets the whole shared pool — math unchanged
  });
  it("defaults labels to null when absent (compute stays pure for label-less callers)", () => {
    const a = computeAllocation(mode, subsidyPerPax, pool, [{ unitId: "u1", tenancyId: "t1", partyId: "p1", pax: 1, airconCharge: 0 }]).allocations[0];
    expect(a.unitCode).toBeNull();
    expect(a.listingType).toBeNull();
  });
});
