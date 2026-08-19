// Pure compute core for M2 unit utility billing. No Prisma, no I/O.
// All amounts are RM numbers. round2 = half-up to 2 decimals.

// Typed compute failure carrying a STABLE error code. The service maps `.code`
// straight to the API `error` field so callers get a stable identifier instead
// of human-readable prose (which is for logs/debugging only).
export class ComputeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ComputeError";
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function periodKey(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function endOfMonthISO(d: Date): string {
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

export type BillingMode = "whole" | "subsidy" | "no_subsidy";

export type PoolComponents = {
  tnbTotal: number;
  airSelangor: number;
  indahWater: number;
  wifi: number;
  cleaning: number;
  /** Fixed monthly maintenance fee. Same bearer-gated shape as wifi/cleaning: it joins the
   *  tenant pool ONLY when its bearer is "tenant", otherwise it is owner-borne. */
  maintenance: number;
};

// Who bears each non-electricity utility line on a given bill.
// leftover-TNB + AirSelangor water are ALWAYS tenant-pooled; aircond is always
// the room's own; subsidy is always the owner's offset. Indah Water / cleaning /
// wifi DEFAULT to the owner (out of the tenant pool) and only join the tenant
// split when explicitly marked "tenant" for that bill.
export type Bearer = "owner" | "tenant";
export type Bearers = { indahWater: Bearer; cleaning: Bearer; wifi: Bearer; maintenance: Bearer };
export const DEFAULT_BEARERS: Bearers = { indahWater: "owner", cleaning: "owner", wifi: "owner", maintenance: "owner" };

export type RoomInput = {
  unitId: string;
  tenancyId: string | null; // null = vacant (no active tenancy)
  partyId: string | null;
  pax: number; // numberOfPax; 0 if unknown/vacant
  airconCharge: number; // MeterReading.computedAmount, 0 if no reading
  unitCode?: string | null; // display label only — never affects math
  listingType?: string | null;
};

/**
 * The per-room GROSS share components — the single declaration of "what makes up a room's
 * gross charge" (lock-step refactor, piece B).
 *
 * AllocationLine derives its share fields from this type, the per-room object below must
 * provide EVERY key, and grossShareTotal is SUMMED from it rather than hand-written. Adding a
 * component therefore cannot be silently left out of the total — which is the failure mode this
 * exists to kill: a share that reaches computedAmount but not the sum (or vice versa) under- or
 * over-bills a tenant with nothing to catch it until the downstream Σ-invariant throws.
 */
// ShareComponents / AllocationLine now live in @kason/shared (types/allocation.ts) so the
// two web copies can IMPORT the shape instead of restating it. Re-exported here because
// this module has long been their import site across the API.
export type { ShareComponents, AllocationLine } from "@kason/shared";
import type { AllocationLine, ShareComponents } from "@kason/shared";

export type ComputeResult = {
  allocations: AllocationLine[];
  totalAircond: number;
  leftoverTnb: number;
  sharedPool: number;
  totalPax: number;
  subsidyCovered: number; // owner-paid subsidy total
  ownerAttributableAircond: number; // Σ vacant rooms' aircon (surfaced, not charged)
  ownerBorneUtilities: number; // Σ owner-borne indah/cleaning/wifi (left out of the tenant pool)
  roundingResidual: number; // sharedPool − Σ grossShareTotal (owner absorbs)
  ownerBorneUtilitiesTotal: number; // ownerAttributableAircond + ownerBorneUtilities + subsidyCovered + roundingResidual
};

type OccupiedRoom = RoomInput & { tenancyId: string; partyId: string };

function partition(rooms: RoomInput[]) {
  const occupied = rooms.filter(
    (r): r is OccupiedRoom => r.tenancyId !== null && r.partyId !== null && r.pax > 0,
  );
  const vacant = rooms.filter((r) => r.tenancyId === null);
  return { occupied, vacant };
}

// One per-apartment model. The shared pool always splits per-pax; aircond is
// billed separately per room (NOT part of the pool). SUBSIDY knocks RM(rate)×pax
// off each room (owner covers it, capped so no charge goes negative).
export function computeAllocation(
  mode: BillingMode,
  subsidyPerPax: number,
  pool: PoolComponents,
  rooms: RoomInput[],
  bearers: Bearers = DEFAULT_BEARERS,
  // PARTITIONED private per-room electricity. When true, each room bills its OWN
  // submeter via the meter path (AC- charges); the Σ aircond MAY exceed the master
  // TNB bill and the excess is OWNER PROFIT (owner pays TNB, recovers more from the
  // private submeters). The AIRCON_EXCEEDS_TNB guard is a WHOLE-unit data-entry
  // check only — one tenant, one master meter, so aircond > TNB is genuinely a
  // mistake there. Default false keeps the shared master-meter model byte-identical.
  privateAircond = false,
): ComputeResult {
  const { occupied, vacant } = partition(rooms);
  const totalAircond = round2(rooms.reduce((s, r) => s + r.airconCharge, 0)); // incl. vacant
  if (!privateAircond && totalAircond > pool.tnbTotal + 0.01) {
    throw new ComputeError("AIRCON_EXCEEDS_TNB", `Submetered aircond (${totalAircond}) exceeds TNB total (${pool.tnbTotal})`);
  }
  // Private units clamp at 0 so the tenant pool never goes negative when the private
  // aircond Σ exceeds TNB; the shared model keeps its exact (never-negative here,
  // because the guard above already rejected aircond > TNB) subtraction.
  const leftoverTnb = privateAircond
    ? round2(Math.max(0, pool.tnbTotal - totalAircond))
    : round2(pool.tnbTotal - totalAircond);

  // Indah Water / cleaning / wifi / maintenance join the tenant pool ONLY when marked
  // "tenant"; otherwise the owner bears them (they leave the tenant split entirely).
  const poolIndah = bearers.indahWater === "tenant" ? pool.indahWater : 0;
  const poolWifi = bearers.wifi === "tenant" ? pool.wifi : 0;
  const poolCleaning = bearers.cleaning === "tenant" ? pool.cleaning : 0;
  const poolMaintenance = bearers.maintenance === "tenant" ? pool.maintenance : 0;
  const ownerBorneUtilities = round2(
    (bearers.indahWater === "owner" ? pool.indahWater : 0) +
      (bearers.wifi === "owner" ? pool.wifi : 0) +
      (bearers.cleaning === "owner" ? pool.cleaning : 0) +
      (bearers.maintenance === "owner" ? pool.maintenance : 0),
  );

  const sharedPool = round2(leftoverTnb + pool.airSelangor + poolIndah + poolWifi + poolCleaning + poolMaintenance);
  const totalPax = occupied.reduce((s, r) => s + r.pax, 0);
  const ownerAttributableAircond = round2(vacant.reduce((s, r) => s + r.airconCharge, 0));

  const base = { totalAircond, leftoverTnb, sharedPool, totalPax, ownerAttributableAircond, ownerBorneUtilities };
  if (totalPax === 0) {
    const roundingResidual = round2(sharedPool);
    return { ...base, allocations: [], subsidyCovered: 0, roundingResidual, ownerBorneUtilitiesTotal: round2(ownerAttributableAircond + ownerBorneUtilities + roundingResidual) };
  }

  const allocations: AllocationLine[] = occupied.map((r) => {
    const shares: ShareComponents = {
      tnbShare: round2((leftoverTnb / totalPax) * r.pax),
      airSelangorShare: round2((pool.airSelangor / totalPax) * r.pax),
      indahShare: round2((poolIndah / totalPax) * r.pax),
      wifiShare: round2((poolWifi / totalPax) * r.pax),
      cleaningShare: round2((poolCleaning / totalPax) * r.pax),
      maintenanceShare: round2((poolMaintenance / totalPax) * r.pax),
    };
    // Σ derived from the map — Object.values keeps the literal key order, so this adds the SAME
    // numbers in the SAME sequence as the previous hand-written sum (identical floating point).
    const grossShareTotal = round2(Object.values(shares).reduce((sum, n) => sum + n, 0));
    const subsidyDeduction = mode === "subsidy" ? round2(Math.min(grossShareTotal, subsidyPerPax * r.pax)) : 0;
    const computedAmount = round2(grossShareTotal - subsidyDeduction);
    return { unitId: r.unitId, tenancyId: r.tenancyId, partyId: r.partyId, pax: r.pax, ...shares, grossShareTotal, subsidyDeduction, computedAmount, unitCode: r.unitCode ?? null, listingType: r.listingType ?? null };
  });

  const subsidyCovered = round2(allocations.reduce((s, a) => s + a.subsidyDeduction, 0));
  const sumGross = round2(allocations.reduce((s, a) => s + a.grossShareTotal, 0));
  const roundingResidual = round2(sharedPool - sumGross);
  const ownerBorneUtilitiesTotal = round2(ownerAttributableAircond + ownerBorneUtilities + subsidyCovered + roundingResidual);
  return { ...base, allocations, subsidyCovered, roundingResidual, ownerBorneUtilitiesTotal };
}
