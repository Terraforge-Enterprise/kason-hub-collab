/**
 * The unit page's headline "Monthly rental" number.
 *
 * It was bound to `unit.rentalRate` — the unit's ASKING rate, which nothing in
 * the assign-tenant flow ever updates. So a unit whose tenant had been assigned
 * at a negotiated RM5 still read "Monthly rental RM2,200.00" (its asking rate),
 * which reads as "the rent I keyed in was ignored". Confirmed against UAT:
 * A-01-03 has rentalRate=2200.00 and an active tenancy at monthlyRentAmount=5.00.
 *
 * An OCCUPIED unit must headline what the tenant actually pays; the asking rate
 * stays visible but clearly subordinate and labelled.
 */
import { describe, it, expect } from "vitest";
import { unitRentDisplay } from "../unit-detail-page";

const base = {
  occupancyStatus: "occupied",
  rentalRate: 2200,
  currency: "MYR",
  activeTenancy: { monthlyRentAmount: 5 },
};

describe("unitRentDisplay", () => {
  it("headlines the tenancy's negotiated rent on an occupied unit, not the asking rate", () => {
    const r = unitRentDisplay(base);
    expect(r.value).toMatch(/5\.00/);
    expect(r.value).not.toMatch(/2,200/);
  });

  it("keeps the asking rate visible, labelled, when it differs", () => {
    const r = unitRentDisplay(base);
    expect(r.detail).toMatch(/asking/i);
    expect(r.detail).toMatch(/2,200\.00/);
  });

  it("falls back to the asking rate when the unit is vacant", () => {
    const r = unitRentDisplay({ ...base, occupancyStatus: "vacant", activeTenancy: null });
    expect(r.value).toMatch(/2,200\.00/);
    expect(r.detail).toMatch(/asking rate/i);
  });

  it("falls back to the asking rate when an older API omits the tenancy rent", () => {
    const r = unitRentDisplay({ ...base, activeTenancy: {} });
    expect(r.value).toMatch(/2,200\.00/);
  });

  it("does not repeat the asking rate when it equals the tenancy rent", () => {
    const r = unitRentDisplay({ ...base, rentalRate: 5 });
    expect(r.value).toMatch(/5\.00/);
    expect(r.detail).not.toMatch(/asking/i);
  });

  it("renders an em-dash, not a crash, when there is no rate at all", () => {
    const r = unitRentDisplay({
      occupancyStatus: "vacant",
      rentalRate: null,
      currency: "MYR",
      activeTenancy: null,
    });
    expect(r.value).toBe("—");
  });
});
