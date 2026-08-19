// PURE, no-I/O. The ONLY seam between the bills-grid module and the shared
// money engine (apps/api/src/modules/meter/compute.ts). The engine takes an
// additive `privateAircond` flag (PARTITIONED private per-room electricity —
// aircond Σ may exceed TNB, excess = owner profit); default false is the
// unchanged shared master-meter model.
//
// It NEVER calls buildComputeInputs (meter/service.ts:435 — shared with the
// charge path, C6) and its output is NEVER persisted to
// UnitUtilityBill.tnbTotal/.airSelangor (C5).
import { round2, type RoomInput } from "../meter/compute";

// P1 | P2 | P3 | P4. Task 5 contract 2: manager_advanced (P4) = KAEN fronted the
// provider payment and RECOVERS it from the tenant pool — recharged semantics
// for the SPLIT (fundedByForUtility, service.ts, is what tells classifyUtilityCharge
// it's a manager recovery, not an owner disbursement).
export type LineBearerPattern = "recharged" | "absorbed" | "tenant_direct" | "manager_advanced";

export class ShapeError extends Error {
  constructor(
    public code: "TNB_UNDERSHOOT",
    public detail: { totalAircond: number; tnbTotal: number },
  ) {
    super(`${code}: aircond ${detail.totalAircond} vs tnb ${detail.tnbTotal}`);
    this.name = "ShapeError";
  }
}

export interface ShapeUtilityPoolInput {
  tnbPattern: LineBearerPattern;
  airPattern: LineBearerPattern;
  rawTnbTotal: number;
  rawAirSelangor: number;
  rooms: RoomInput[];
}

export interface ShapeUtilityPoolResult {
  tnbTotal: number;
  airSelangor: number;
  shaped: { tnb: boolean; air: boolean };
}

export function shapeUtilityPool(input: ShapeUtilityPoolInput): ShapeUtilityPoolResult {
  // Identical formula to compute.ts:107 — over ALL rooms, including vacant.
  const totalAircond = round2(input.rooms.reduce((s, r) => s + r.airconCharge, 0));

  // Task 5 contract 2 (money bug guard): ONLY "absorbed" (owner pays the FULL
  // provider bill) and "tenant_direct" (tenant pays the provider directly,
  // outside the grid pool entirely) zero the pool. "recharged" AND
  // "manager_advanced" both flow the FULL raw amount into the tenant pool —
  // manager_advanced differs from recharged only in WHO funded it
  // (fundedByForUtility routes it to a manager recovery, not an owner
  // disbursement), never in how much reaches the pool. The prior
  // `!== "recharged"` phrasing wrongly zeroed manager_advanced's pool
  // contribution (treating it as absorbed) — money bug, since KAEN's advance
  // would never be recovered from the tenant pool.
  const tnbAbsorbedAway = input.tnbPattern === "absorbed" || input.tnbPattern === "tenant_direct";
  const airAbsorbedAway = input.airPattern === "absorbed" || input.airPattern === "tenant_direct";

  let tnbTotal: number;
  if (tnbAbsorbedAway) {
    // C1: the ONLY safe absorbed value. Exact equality ⇒ leftoverTnb = round2(0) = 0.
    // Any smaller value: ≤0.01 under yields a SILENT leftoverTnb = -0.01 (compute.ts:108
    // is a strict `>` with +0.01 slack); >0.01 under throws AIRCON_EXCEEDS_TNB.
    tnbTotal = totalAircond;
  } else {
    tnbTotal = round2(input.rawTnbTotal);
    // Refuse the silent-negative band [totalAircond - 0.01, totalAircond).
    // Below that band we pass through and let compute.ts:108 throw AIRCON_EXCEEDS_TNB.
    if (tnbTotal < totalAircond && tnbTotal >= round2(totalAircond - 0.01)) {
      throw new ShapeError("TNB_UNDERSHOOT", { totalAircond, tnbTotal });
    }
  }

  // C2: airSelangor is added UNCONDITIONALLY at compute.ts:124 — no bearer gate.
  // It must be zeroed SEPARATELY; zeroing TNB alone still charges tenants for water.
  const airSelangor = airAbsorbedAway ? 0 : round2(input.rawAirSelangor);

  return { tnbTotal, airSelangor, shaped: { tnb: tnbAbsorbedAway, air: airAbsorbedAway } };
}
