import { describe, it, expect } from "vitest";
import { computeAllocation, ComputeError, DEFAULT_BEARERS, round2, type PoolComponents, type RoomInput } from "../compute";

const pool = (p: Partial<PoolComponents> = {}): PoolComponents => ({
  tnbTotal: 0, airSelangor: 0, indahWater: 0, wifi: 0, cleaning: 0, maintenance: 0, ...p,
});
const room = (id: string, pax: number, aircon = 0, occupied = true): RoomInput => ({
  unitId: id, tenancyId: occupied ? `t-${id}` : null, partyId: occupied ? `p-${id}` : null,
  pax: occupied ? pax : 0, airconCharge: aircon,
});

describe("computeAllocation", () => {
  it("SUBSIDY worked example → master 43.33 / medium 16.67, owner covers 150", () => {
    // tnbTotal 60 (aircond 40 submetered out → leftover 20) + water 150 = shared pool 170; 3 pax; rate 50.
    const r = computeAllocation("subsidy", 50, pool({ tnbTotal: 60, airSelangor: 150 }),
      [room("master", 2, 30), room("medium", 1, 10)]);
    expect(r.leftoverTnb).toBe(20);
    expect(r.sharedPool).toBe(170);
    const master = r.allocations.find((a) => a.unitId === "master")!;
    const medium = r.allocations.find((a) => a.unitId === "medium")!;
    expect(master.subsidyDeduction).toBe(100); // min(113.33, 50*2)
    expect(medium.subsidyDeduction).toBe(50);  // min(56.67, 50*1)
    expect(master.computedAmount).toBe(13.33); // 113.33 − 100  (+ aircond 30 → RM43.33 on the bill)
    expect(medium.computedAmount).toBe(6.67);  // 56.67 − 50    (+ aircond 10 → RM16.67 on the bill)
    expect(r.subsidyCovered).toBe(150);
    expect(r.ownerBorneUtilitiesTotal).toBeCloseTo(150 + r.roundingResidual, 2);
  });

  it("NO_SUBSIDY: full pool split per-pax, no deduction", () => {
    const r = computeAllocation("no_subsidy", 50, pool({ airSelangor: 90 }),
      [room("a", 2), room("b", 1)]);
    expect(r.allocations.find((x) => x.unitId === "a")!.computedAmount).toBe(60);
    expect(r.allocations.find((x) => x.unitId === "b")!.computedAmount).toBe(30);
    expect(r.subsidyCovered).toBe(0);
  });

  it("WHOLE: single tenant bears the tenant pool; wifi defaults owner-borne", () => {
    const r = computeAllocation("whole", 50, pool({ airSelangor: 100, wifi: 50 }), [room("u", 1)]);
    expect(r.allocations[0].computedAmount).toBe(100); // airSelangor only; wifi → owner
    expect(r.ownerBorneUtilities).toBe(50);
    expect(r.subsidyCovered).toBe(0);
  });

  it("SUBSIDY excess=0: pool below subsidy → tenants pay 0 shared, owner covers all", () => {
    const r = computeAllocation("subsidy", 50, pool({ airSelangor: 80 }), [room("a", 2)]); // 80 < 100
    expect(r.allocations[0].computedAmount).toBe(0);
    expect(r.subsidyCovered).toBe(80);
  });

  it("indah/cleaning/wifi DEFAULT owner-borne — out of the tenant pool", () => {
    const r = computeAllocation("no_subsidy", 50,
      pool({ airSelangor: 10, indahWater: 20, cleaning: 90, wifi: 30 }), [room("a", 1)]);
    expect(r.sharedPool).toBe(10); // only airSelangor (no TNB)
    expect(r.allocations[0].computedAmount).toBe(10);
    expect(r.allocations[0].indahShare).toBe(0);
    expect(r.allocations[0].cleaningShare).toBe(0);
    expect(r.allocations[0].wifiShare).toBe(0);
    expect(r.ownerBorneUtilities).toBe(140); // 20 + 90 + 30
  });

  it("WiFi joins the pool only when toggled to tenant", () => {
    const r = computeAllocation("no_subsidy", 50, pool({ wifi: 30 }), [room("a", 1)],
      { indahWater: "owner", cleaning: "owner", wifi: "tenant", maintenance: "owner" });
    expect(r.sharedPool).toBe(30);
    expect(r.allocations[0].wifiShare).toBe(30);
    expect(r.ownerBorneUtilities).toBe(0);
  });

  it("toggle cleaning→tenant pools it; owner total drops", () => {
    const r = computeAllocation("no_subsidy", 50, pool({ cleaning: 90 }), [room("a", 1)],
      { indahWater: "owner", cleaning: "tenant", wifi: "owner", maintenance: "owner" });
    expect(r.sharedPool).toBe(90);
    expect(r.allocations[0].cleaningShare).toBe(90);
    expect(r.allocations[0].computedAmount).toBe(90);
    expect(r.ownerBorneUtilities).toBe(0);
  });

  it("user worked example (default owner): TNB 500, aircond 40+60, water 10, subsidy → shares 86.66 / 173.34 (bill Σ = RM360)", () => {
    const r = computeAllocation("subsidy", 50, pool({ tnbTotal: 500, airSelangor: 10 }),
      [room("A", 1, 40), room("B", 2, 60)]);
    expect(r.leftoverTnb).toBe(400);
    expect(r.sharedPool).toBe(410);
    const A = r.allocations.find((a) => a.unitId === "A")!;
    const B = r.allocations.find((a) => a.unitId === "B")!;
    // per-component round2: A = 133.33+3.33−50 = 86.66 ; B = 266.67+6.67−100 = 173.34
    expect(A.computedAmount).toBe(86.66); // + own aircond 40 → RM126.66 on the bill
    expect(B.computedAmount).toBe(173.34); // + own aircond 60 → RM233.34 on the bill
    // bill total = (86.66+40) + (173.34+60) = 360.00 = TNB 500 − subsidy 150 + water 10
    expect(round2(A.computedAmount + 40 + B.computedAmount + 60)).toBe(360);
  });

  it("vacant room: not billed; its aircon is owner-attributable", () => {
    const r = computeAllocation("no_subsidy", 50, pool({ tnbTotal: 50, airSelangor: 10 }),
      [room("occ", 1, 0), room("vac", 0, 12, false)]);
    expect(r.allocations).toHaveLength(1);
    expect(r.ownerAttributableAircond).toBe(12);
    expect(r.leftoverTnb).toBe(38); // 50 − 12 aircon
  });

  it("guard: aircond > TNB throws AIRCON_EXCEEDS_TNB (default: shared master-meter model)", () => {
    expect(() => computeAllocation("no_subsidy", 50, pool({ tnbTotal: 10 }), [room("a", 1, 20)]))
      .toThrow(ComputeError);
  });

  // ── PARTITIONED private per-room electricity (privateAircond = true) ──────────
  // Each room bills its OWN submeter via the meter path (AC- charges); the Σ MAY
  // exceed the master TNB bill and the excess is OWNER PROFIT. The guard is a
  // WHOLE-unit data-entry check only, and leftoverTnb clamps at 0.

  it("private: aircond > TNB does NOT throw — user case TNB 300 vs rooms 24/180/150 = 354", () => {
    // No pooled utilities beyond TNB → each room's pooled share is 0; the RM354 of
    // aircond is billed per-room by the meter path (owner recovers 354, pays TNB 300
    // → RM54 owner profit). leftoverTnb clamps to 0 (never a negative pool).
    const r = computeAllocation(
      "no_subsidy", 0, pool({ tnbTotal: 300 }),
      [room("master", 1, 180), room("medium", 1, 150), room("small", 1, 24)],
      DEFAULT_BEARERS, true,
    );
    expect(r.totalAircond).toBe(354);
    expect(r.leftoverTnb).toBe(0); // clamped, NOT −54
    expect(r.allocations.every((a) => a.tnbShare === 0)).toBe(true);
  });

  it("private: aircond < TNB is a pure no-op — leftover identical to the shared model", () => {
    const shared = computeAllocation("no_subsidy", 0, pool({ tnbTotal: 100, airSelangor: 30 }), [room("a", 1, 40)]);
    const priv = computeAllocation("no_subsidy", 0, pool({ tnbTotal: 100, airSelangor: 30 }), [room("a", 1, 40)], DEFAULT_BEARERS, true);
    expect(priv.leftoverTnb).toBe(60); // 100 − 40, unchanged
    expect(priv.leftoverTnb).toBe(shared.leftoverTnb);
    expect(priv.allocations[0].computedAmount).toBe(shared.allocations[0].computedAmount);
  });

  it("private=false (WHOLE) still throws on the SAME inputs a private unit accepts", () => {
    const rooms = [room("a", 1, 354)];
    expect(() => computeAllocation("whole", 0, pool({ tnbTotal: 300 }), rooms, DEFAULT_BEARERS, false)).toThrow(ComputeError);
    expect(() => computeAllocation("no_subsidy", 0, pool({ tnbTotal: 300 }), rooms, DEFAULT_BEARERS, true)).not.toThrow();
  });
});

// ── MAINTENANCE (2026-07-28) — billable scalar, same bearer-gated shape as cleaning/wifi ──
// The compute-freeze re-pin claims this addition is ADDITIVE. These cases are that proof.
describe("maintenance", () => {
  const rooms = [room("A", 1), room("B", 1)];

  it("owner-bearer (the default) leaves every tenant share untouched", () => {
    const without = computeAllocation("no_subsidy", 0, pool({ tnbTotal: 100, maintenance: 0 }), rooms, DEFAULT_BEARERS);
    const withOwnerBorne = computeAllocation("no_subsidy", 0, pool({ tnbTotal: 100, maintenance: 60 }), rooms, DEFAULT_BEARERS);

    expect(withOwnerBorne.sharedPool).toBe(without.sharedPool);
    expect(withOwnerBorne.allocations.map((a) => a.computedAmount)).toEqual(
      without.allocations.map((a) => a.computedAmount),
    );
    // ...and the owner picks it up instead of the tenants.
    expect(withOwnerBorne.ownerBorneUtilities).toBe(round2(without.ownerBorneUtilities + 60));
  });

  it("tenant-bearer splits it per pax exactly like cleaning does", () => {
    const bearers = { ...DEFAULT_BEARERS, maintenance: "tenant" as const };
    const asMaintenance = computeAllocation("no_subsidy", 0, pool({ maintenance: 60 }), rooms, bearers);
    const asCleaning = computeAllocation("no_subsidy", 0, pool({ cleaning: 60 }), rooms,
      { ...DEFAULT_BEARERS, cleaning: "tenant" as const });

    expect(asMaintenance.allocations.map((a) => a.maintenanceShare)).toEqual([30, 30]);
    expect(asMaintenance.allocations.map((a) => a.computedAmount)).toEqual(
      asCleaning.allocations.map((a) => a.computedAmount),
    );
    expect(asMaintenance.ownerBorneUtilities).toBe(0);
  });

  it("counts into grossShareTotal alongside the other components", () => {
    const r = computeAllocation("no_subsidy", 0, pool({ tnbTotal: 20, maintenance: 40 }), rooms,
      { ...DEFAULT_BEARERS, maintenance: "tenant" as const });
    const a = r.allocations[0];
    expect(a.maintenanceShare).toBe(20);
    expect(a.grossShareTotal).toBe(round2(a.tnbShare + a.airSelangorShare + a.indahShare + a.wifiShare + a.cleaningShare + a.maintenanceShare));
  });
});
