import { describe, expect, it } from "vitest";
// The REAL frozen engine — never a mock. These tests double as compute pins.
import { computeAllocation, ComputeError, DEFAULT_BEARERS, type PoolComponents, type RoomInput } from "../../meter/compute";
import { shapeUtilityPool, ShapeError } from "../shape";

const room = (id: string, pax: number, airconCharge: number): RoomInput => ({
  unitId: id, tenancyId: `t-${id}`, partyId: `p-${id}`, pax, airconCharge,
});
// Σ airconCharge = 33.33 + 33.33 + 33.34 = 100.00 exactly under round2.
const DIRTY = [room("A", 2, 33.33), room("B", 1, 33.33), room("C", 3, 33.34)];

const poolFrom = (s: { tnbTotal: number; airSelangor: number }): PoolComponents => ({
  tnbTotal: s.tnbTotal, airSelangor: s.airSelangor, indahWater: 0, wifi: 0, cleaning: 0, maintenance: 0,
});

describe("shapeUtilityPool", () => {
  it("dirty-float P2 absorb-TNB: leftoverTnb is exactly 0, all tnbShare 0, no throw", () => {
    const s = shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "absorbed", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect(s.tnbTotal).toBe(100);
    expect(s.airSelangor).toBe(0);
    expect(s.shaped).toEqual({ tnb: true, air: true });

    const r = computeAllocation("no_subsidy", 0, poolFrom(s), DIRTY, DEFAULT_BEARERS);
    expect(r.leftoverTnb).toBe(0);
    expect(r.sharedPool).toBe(0);
    for (const a of r.allocations) expect(a.tnbShare).toBe(0);
  });

  it("undershoot: a recharged line at totalAircond - 0.01 is refused with TNB_UNDERSHOOT", () => {
    const totalAircond = 100;
    expect(() =>
      shapeUtilityPool({ tnbPattern: "recharged", airPattern: "recharged", rawTnbTotal: totalAircond - 0.01, rawAirSelangor: 0, rooms: DIRTY }),
    ).toThrowError(ShapeError);
    try {
      shapeUtilityPool({ tnbPattern: "recharged", airPattern: "recharged", rawTnbTotal: 99.99, rawAirSelangor: 0, rooms: DIRTY });
    } catch (e) {
      expect((e as ShapeError).code).toBe("TNB_UNDERSHOOT");
      expect((e as ShapeError).detail).toEqual({ totalAircond: 100, tnbTotal: 99.99 });
    }
    // Sibling pin: raw compute with that value silently yields -0.01 (compute.ts:108 is `>` with +0.01 slack).
    const raw = computeAllocation("no_subsidy", 0, poolFrom({ tnbTotal: 99.99, airSelangor: 0 }), DIRTY, DEFAULT_BEARERS);
    expect(raw.leftoverTnb).toBe(-0.01);
  });

  it("AIRCON_EXCEEDS_TNB: a recharged line below the undershoot band lets compute throw", () => {
    const rooms = [room("A", 1, 100.5)];
    const s = shapeUtilityPool({ tnbPattern: "recharged", airPattern: "recharged", rawTnbTotal: 100, rawAirSelangor: 0, rooms });
    expect(s.tnbTotal).toBe(100); // adapter passes it through — 100 < 100.5 - 0.01
    expect(() => computeAllocation("no_subsidy", 0, poolFrom(s), rooms, DEFAULT_BEARERS)).toThrowError(ComputeError);
  });

  it("C2: absorbing TNB alone still charges tenants for water; absorbing AIR zeroes it", () => {
    const tnbOnly = shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "recharged", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect(tnbOnly.airSelangor).toBe(40);
    const r1 = computeAllocation("no_subsidy", 0, poolFrom(tnbOnly), DIRTY, DEFAULT_BEARERS);
    expect(r1.allocations.some((a) => a.airSelangorShare > 0)).toBe(true);

    const both = shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "absorbed", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    const r2 = computeAllocation("no_subsidy", 0, poolFrom(both), DIRTY, DEFAULT_BEARERS);
    for (const a of r2.allocations) expect(a.airSelangorShare).toBe(0);
  });

  it("C3: ComputeResult understates the owner burden — record it from the raw inputs", () => {
    const rooms = [room("A", 2, 0), room("B", 1, 0), room("C", 3, 0)];
    const pool: PoolComponents = { tnbTotal: 400, airSelangor: 90, indahWater: 100, wifi: 40, cleaning: 40 , maintenance: 0};
    const baseline = computeAllocation("no_subsidy", 0, pool, rooms, DEFAULT_BEARERS);
    expect(baseline.ownerBorneUtilitiesTotal).toBe(180); // indah 100 + wifi 40 + cleaning 40

    const s = shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "absorbed", rawTnbTotal: 400, rawAirSelangor: 90, rooms });
    const shapedResult = computeAllocation("no_subsidy", 0, { ...pool, tnbTotal: s.tnbTotal, airSelangor: s.airSelangor }, rooms, DEFAULT_BEARERS);
    expect(shapedResult.ownerBorneUtilitiesTotal).toBe(180); // STILL 180 — the 490 is invisible
    // The real owner burden, from RAW inputs, is 400 + 90 = 490. The grid must store this.
    expect(400 + 90).toBe(490);
  });

  it("tenant_direct shapes identically to absorbed (P2 ≡ P3 in compute — C4 needs the discriminator)", () => {
    const p2 = shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "absorbed", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    const p3 = shapeUtilityPool({ tnbPattern: "tenant_direct", airPattern: "tenant_direct", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect({ tnbTotal: p3.tnbTotal, airSelangor: p3.airSelangor }).toEqual({ tnbTotal: p2.tnbTotal, airSelangor: p2.airSelangor });
  });

  it("fresh-literal: the adapter never mutates the rooms array or any pool object", () => {
    const before = JSON.parse(JSON.stringify(DIRTY));
    const pool = poolFrom({ tnbTotal: 590, airSelangor: 40 });
    const poolBefore = { ...pool };
    shapeUtilityPool({ tnbPattern: "absorbed", airPattern: "absorbed", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    computeAllocation("no_subsidy", 0, pool, DIRTY, DEFAULT_BEARERS);
    expect(DIRTY).toEqual(before);
    expect(pool).toEqual(poolBefore);
  });

  // Audit-driven coverage pin (test-only; shape.ts unchanged). The brief's two
  // "recharged" tests are both degenerate (one throws, one has aircon EXCEEDING
  // TNB). This pins the adapter's PRIMARY job: a valid TNB above Σ aircond passes
  // through untouched, yielding a positive tenant pool.
  it("recharged happy-path: a valid TNB above Σ aircond passes through untouched (positive leftoverTnb)", () => {
    const s = shapeUtilityPool({ tnbPattern: "recharged", airPattern: "recharged", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect(s.tnbTotal).toBe(590);
    expect(s.airSelangor).toBe(40);
    expect(s.shaped).toEqual({ tnb: false, air: false });
    const r = computeAllocation("no_subsidy", 0, poolFrom(s), DIRTY, DEFAULT_BEARERS);
    expect(r.leftoverTnb).toBe(490); // 590 TNB − 100 Σ aircon
  });

  // Task 5 contract 2 (money bug guard): manager_advanced means KAEN fronted the
  // provider payment and RECOVERS it from the tenant pool — recharged semantics
  // for the split, NOT absorbed. `as never` mirrors service.ts:968's own cast
  // (entry.tnbPattern/airPattern are plain untyped DB `string` columns; the type
  // is widened to include "manager_advanced" as part of this same fix).
  it("manager_advanced tnb/air shape identically to recharged (NOT absorbed) — Task 5 contract 2", () => {
    const recharged = shapeUtilityPool({ tnbPattern: "recharged", airPattern: "recharged", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    const managerAdvanced = shapeUtilityPool({ tnbPattern: "manager_advanced" as never, airPattern: "manager_advanced" as never, rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect(managerAdvanced.tnbTotal).toBe(recharged.tnbTotal); // 590 — NOT absorbed-away to 100
    expect(managerAdvanced.airSelangor).toBe(recharged.airSelangor); // 40 — NOT zeroed
    expect(managerAdvanced.shaped).toEqual({ tnb: false, air: false });
  });

  // Independence guard (mirrors the existing "C2" test's tnb/air-independence
  // shape): manager_advanced TNB alone (air still absorbed) must recharge the
  // tenant pool for TNB while air is STILL zeroed — proves the two patterns are
  // evaluated independently, not conflated by a copy-paste fix.
  it("manager_advanced TNB alone (air absorbed) — independent evaluation", () => {
    const s = shapeUtilityPool({ tnbPattern: "manager_advanced" as never, airPattern: "absorbed", rawTnbTotal: 590, rawAirSelangor: 40, rooms: DIRTY });
    expect(s.tnbTotal).toBe(590); // recharged semantics for TNB
    expect(s.airSelangor).toBe(0); // air independently still absorbed-away
    expect(s.shaped).toEqual({ tnb: false, air: true });
  });
});
