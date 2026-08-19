/**
 * Batch loaders (Task 2) — `resolveRoomRatesBatch` + `resolveRoomRentsBatch`.
 * Integration suite against a real local Postgres, mirroring the harness convention
 * established by `service.integration.test.ts` (getDb + RUN_INTEGRATION gate +
 * non-local host guard) and this repo's dedicated-fixture style for money-critical
 * isolation (`meter/__tests__/service.integration.test.ts`'s own ORG/PROP/APT/ROOM
 * set) rather than reusing the shared 20-apartment clean-dev-seed pool: this suite
 * needs EXACT, deterministic AircondMeter/RecurringCharge/UnitReservation state
 * (active / retired / absent; two competing rent RecurringCharges with a forced
 * id order), which a shared pool cannot guarantee across concurrent suites.
 *
 * ORG itself IS the shared local seeded org (org-scoped, per the task brief) —
 * only the Party/Apartment/Listing/Tenancy/UnitReservation/RecurringCharge rows
 * below are freshly minted and torn down in `afterAll`.
 *
 * Run:
 *   cd apps/api && DATABASE_URL=<local> RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/bills-grid/__tests__/batch-loaders.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { resolveRoomRatesBatch, resolveRoomRentsBatch } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const prisma = getDb();

/**
 * `vi.spyOn(obj, method)` alone does NOT reliably call through to Prisma's real
 * model-delegate methods in this setup — empirically verified: the resulting spy
 * invokes but returns `undefined` instead of executing the query, because Prisma's
 * generated methods depend on a `this` binding that Vitest's default spy wrapper
 * does not preserve. Binding the captured original explicitly (and installing it
 * via `mockImplementation`) fixes call-through.
 *
 * SEPARATELY, `spy.mockRestore()` was ALSO empirically found to corrupt the
 * property afterward (`db.aircondMeter.findMany is not a function` in every test
 * that ran after a `mockRestore()`'d spy) — so restoration is done by hand
 * (reassigning the captured original directly) instead of trusting
 * `mockRestore()`. Always use this helper — install, assert, then call the
 * returned `restore()` (never `spy.mockRestore()`) — when spying on a Prisma
 * Client method in this file.
 */
function spyCallthrough<T extends object, K extends keyof T>(target: T, method: K) {
  const original = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
  const spy = vi.spyOn(target, method as never).mockImplementation(original as never);
  const restore = () => {
    (target as unknown as Record<string, unknown>)[method as string] = original;
  };
  return { spy, restore };
}

// The queried period for every rent case below: 2026-08-01 (August, 31 days) —
// chosen so "fully occupied" and "mid-month" proration land on clean, hand-checkable
// fractions (16/31 etc.), and so it never collides with other suites' PERIOD
// (service.integration.test.ts uses 2026-07-01; meter suites use their own ORGs).
const PERIOD = new Date(Date.UTC(2026, 7, 1));

let ORG = "";
let PROPERTY = "";
let PARTY = "";
let APT = "";

// ── Rate-side fixtures (rooms = Listings) ───────────────────────────────────
let L1 = ""; // active meter, rate 0.5500
let L2 = ""; // RETIRED meter (isActive:false), rate 0.5500 — the meter-parity case
let L3 = ""; // no meter row at all → lazy default
let L4 = ""; // no meter row at all (2nd) → batch padding for the N+1 count test
let L5 = ""; // active meter, DIFFERENT rate 0.7500 → batch padding, distinct value
let L6 = ""; // active meter whose rate happens to equal the LAZY DEFAULT (0.6000) — configured:true must still hold
let L7 = ""; // no rate-side significance — a fresh, unused room providing T7's required unitId
let L8 = ""; // no rate-side significance — a fresh, unused room providing T8's required unitId
let L9 = ""; // no rate-side significance — a fresh, unused room providing T9's required unitId

// ── Rent-side fixtures (Tenancies) ──────────────────────────────────────────
let T1 = ""; // reservation.agreedMonthlyRent 1800.00, fully occupied → "1800.00"
let T2 = ""; // reservation 2000.00 + TWO active RCs (700, 500) → lowest-id RC (500) wins
let T3 = ""; // no RC, no reservation → Tenancy.monthlyRentAmount fallback, fully occupied
let T4 = ""; // no RC, no reservation, mid-month start → prorated fraction
let T5 = ""; // occupancy window entirely BEFORE the period → "0.00"
let T6 = ""; // occupancy window entirely AFTER the period (future move-in) → "0.00"
let T7 = ""; // reservation row EXISTS but agreedMonthlyRent is NULL → tenancy fallback (adversarial-audit B16)
let T8 = ""; // reservation 1600 + an INACTIVE rent RC (9999, must be ignored) → reservation wins (B17)
let T9 = ""; // reservation 1700 + an ACTIVE non-rent RC (9999, must be ignored) → reservation wins (B18)

// ── Cross-org fixtures (org-scoping / permission behaviors) ────────────────
let OTHER_ORG = "";
let OTHER_PROPERTY = "";
let OTHER_PARTY = "";
let OTHER_APT = "";
let L_FOREIGN = ""; // foreign-org listing with its OWN meter, rate 0.9900 — must never leak
let T_FOREIGN = ""; // foreign-org tenancy, rent 5000.00 — must never resolve under ORG

// Fixed, order-controlled ids for the RecurringCharge tie-break (T2): the HIGHER
// id is inserted FIRST and the LOWER id SECOND, specifically so the assertion
// cannot pass by coincidence of insertion order — only a genuine `orderBy: {id:"asc"}`
// (or equivalent deterministic tie-break) picks the lower one.
const RC_HIGH_ID = "d2000000-0000-4000-8000-000000000099";
const RC_LOW_ID = "d2000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  PROPERTY = prop.id;

  PARTY = (
    await prisma.party.create({
      data: { organizationId: ORG, displayName: "Batch-Loader Test Party", partyType: "individual", status: "active" },
    })
  ).id;
  APT = (
    await prisma.apartment.create({
      data: { organizationId: ORG, propertyId: PROPERTY, unitCode: `BL-${Date.now()}`, listingMode: "PARTITIONED" },
    })
  ).id;

  // Listing carries `@@unique([apartmentId, listingType])` — each room under the
  // shared APT needs its own distinct listingType tag, not a real room-type value.
  const mkListing = async (tag: string) =>
    (
      await prisma.listing.create({
        data: { organizationId: ORG, apartmentId: APT, listingType: `bl-room-${tag}`, occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY },
      })
    ).id;
  L1 = await mkListing("1");
  L2 = await mkListing("2");
  L3 = await mkListing("3");
  L4 = await mkListing("4");
  L5 = await mkListing("5");
  L6 = await mkListing("6");
  // L7-L9: no rate-side significance — just fresh, unused rooms for T7/T8/T9
  // ("one active Tenancy per unit" partial index means each new tenancy needs
  // its own unit; see the mkTenancy note below).
  L7 = await mkListing("7");
  L8 = await mkListing("8");
  L9 = await mkListing("9");

  await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: L1, ratePerKwh: "0.5500", isActive: true } });
  await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: L2, ratePerKwh: "0.5500", isActive: false } });
  // L3, L4: deliberately NO AircondMeter row.
  await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: L5, ratePerKwh: "0.7500", isActive: true } });
  // L6: a REAL, ACTIVE, configured meter whose rate happens to equal the lazy
  // default (0.6000) — a wrong implementation like `configured: rate !== 0.6`
  // would misreport this as unconfigured; only "a row exists" is correct.
  await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: L6, ratePerKwh: "0.6000", isActive: true } });

  // NOTE: a raw-SQL migration (20260707130000_tenancy_one_active_per_unit) adds a
  // Postgres PARTIAL unique index `(organizationId, unitId) WHERE status='active'`
  // that Prisma 7 cannot express in schema.prisma (so it is invisible to a schema
  // read) — at most ONE active Tenancy per unit. Each tenancy below therefore gets
  // its OWN unit (reusing the L1-L5 rooms already minted for the rate-side tests).
  const mkTenancy = async (opts: { unitId: string; startDate: string; endDate?: string | null; monthlyRentAmount: string; reservationId?: string }) =>
    (
      await prisma.tenancy.create({
        data: {
          organizationId: ORG,
          propertyId: PROPERTY,
          unitId: opts.unitId,
          tenantPartyId: PARTY,
          tenancyCode: `BL-T-${randomUUID()}`,
          status: "active",
          billingStatus: "current",
          startDate: new Date(opts.startDate),
          endDate: opts.endDate ? new Date(opts.endDate) : null,
          monthlyRentAmount: opts.monthlyRentAmount,
          reservationId: opts.reservationId ?? null,
        },
      })
    ).id;

  const mkReservation = async (unitId: string, agreedMonthlyRent: string | null) =>
    (
      await prisma.unitReservation.create({
        data: {
          organizationId: ORG,
          referenceCode: `BL-R-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          issuedByPartyId: PARTY,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          publicToken: `bl-${randomUUID()}`,
          propertyId: PROPERTY,
          unitId,
          proposedMoveIn: new Date("2026-01-01T00:00:00.000Z"),
          reservationDeposit: "0.00",
          documentationFee: "0.00",
          rentalDeposit: "0.00",
          utilityDeposit: "0.00",
          accessCardDeposit: "0.00",
          agreedMonthlyRent,
        },
      })
    ).id;

  // T1: reservation-linked, 1800.00, fully occupied for PERIOD (2026-08-01).
  const resv1 = await mkReservation(L1, "1800.00");
  T1 = await mkTenancy({ unitId: L1, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "999.00", reservationId: resv1 });

  // T2: reservation 2000.00 (must lose) + TWO active RecurringCharge(rent) rows
  // (700 inserted first, 500 inserted second, ids reversed — see RC_HIGH_ID/RC_LOW_ID
  // above) — the lowest-id row (500) must win over BOTH the reservation and the
  // higher-id RC. Fully occupied for PERIOD.
  const resv2 = await mkReservation(L2, "2000.00");
  T2 = await mkTenancy({ unitId: L2, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "999.00", reservationId: resv2 });
  await prisma.recurringCharge.create({
    data: { id: RC_HIGH_ID, organizationId: ORG, tenancyId: T2, chargeType: "rent", amount: "700.00", isActive: true, nextChargeDate: new Date("2026-09-01T00:00:00.000Z") },
  });
  await prisma.recurringCharge.create({
    data: { id: RC_LOW_ID, organizationId: ORG, tenancyId: T2, chargeType: "rent", amount: "500.00", isActive: true, nextChargeDate: new Date("2026-09-01T00:00:00.000Z") },
  });

  // T3: no RC, no reservation → Tenancy.monthlyRentAmount fallback. Fully occupied.
  T3 = await mkTenancy({ unitId: L3, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "1200.00" });

  // T4: no RC, no reservation, starts mid-month (Aug 16) → occupiedDays 16/31.
  // round2(3000 * 16 / 31) = 1548.39.
  T4 = await mkTenancy({ unitId: L4, startDate: "2026-08-16T00:00:00.000Z", endDate: null, monthlyRentAmount: "3000.00" });

  // T5: occupancy window entirely BEFORE PERIOD (moved out in May) → 0.00.
  T5 = await mkTenancy({ unitId: L5, startDate: "2026-05-01T00:00:00.000Z", endDate: "2026-05-31T00:00:00.000Z", monthlyRentAmount: "800.00" });

  // T6: occupancy window entirely AFTER PERIOD (future move-in, Oct) → 0.00.
  // Distinct boundary from T5 (past move-out): proves the batch loader forwards
  // `period` correctly on the OTHER side of the window too.
  T6 = await mkTenancy({ unitId: L6, startDate: "2026-10-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "750.00" });

  // T7: a REAL reservation row exists but its agreedMonthlyRent is NULL (a
  // customer reservation that never had rent negotiated) — must fall back to
  // Tenancy.monthlyRentAmount, NOT crash and NOT bill "0.00" (adversarial-audit
  // finding: dropping the `!= null` guard bills RM0 rent for real occupancy).
  const resv7 = await mkReservation(L7, null);
  T7 = await mkTenancy({ unitId: L7, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "1100.00", reservationId: resv7 });

  // T8: reservation 1600.00 (must win) + an INACTIVE rent RecurringCharge
  // (9999.00, must be ignored — the isActive:true filter excludes it).
  const resv8 = await mkReservation(L8, "1600.00");
  T8 = await mkTenancy({ unitId: L8, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "999.00", reservationId: resv8 });
  await prisma.recurringCharge.create({
    data: { organizationId: ORG, tenancyId: T8, chargeType: "rent", amount: "9999.00", isActive: false, nextChargeDate: new Date("2026-09-01T00:00:00.000Z") },
  });

  // T9: reservation 1700.00 (must win) + an ACTIVE but NON-RENT RecurringCharge
  // (9999.00 "utility", must be ignored — the chargeType:"rent" filter excludes it).
  const resv9 = await mkReservation(L9, "1700.00");
  T9 = await mkTenancy({ unitId: L9, startDate: "2026-01-01T00:00:00.000Z", endDate: null, monthlyRentAmount: "999.00", reservationId: resv9 });
  await prisma.recurringCharge.create({
    data: { organizationId: ORG, tenancyId: T9, chargeType: "utility", amount: "9999.00", isActive: true, nextChargeDate: new Date("2026-09-01T00:00:00.000Z") },
  });

  // ── Cross-org fixtures ──
  const other = await prisma.organization.create({
    data: { name: "BL Other Org", slug: `bl-other-${Date.now()}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  OTHER_ORG = other.id;
  OTHER_PARTY = (await prisma.party.create({ data: { organizationId: OTHER_ORG, displayName: "Foreign Party", partyType: "individual", status: "active" } })).id;
  OTHER_PROPERTY = (
    await prisma.property.create({
      data: { organizationId: OTHER_ORG, name: "BL Other Property", propertyCode: `BL-OP-${Date.now()}`, propertyType: "residential", addressLine1: "1 Foreign St", city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft" },
    })
  ).id;
  OTHER_APT = (
    await prisma.apartment.create({ data: { organizationId: OTHER_ORG, propertyId: OTHER_PROPERTY, unitCode: `BL-OA-${Date.now()}`, listingMode: "WHOLE" } })
  ).id;
  L_FOREIGN = (
    await prisma.listing.create({
      data: { organizationId: OTHER_ORG, apartmentId: OTHER_APT, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OTHER_PARTY },
    })
  ).id;
  await prisma.aircondMeter.create({ data: { organizationId: OTHER_ORG, unitId: L_FOREIGN, ratePerKwh: "0.9900", isActive: true } });
  T_FOREIGN = (
    await prisma.tenancy.create({
      data: {
        organizationId: OTHER_ORG, propertyId: OTHER_PROPERTY, unitId: L_FOREIGN, tenantPartyId: OTHER_PARTY,
        tenancyCode: `BL-OT-${randomUUID()}`, status: "active", billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: null, monthlyRentAmount: "5000.00",
      },
    })
  ).id;
});

afterAll(async () => {
  if (!RUN) return;
  const localTenancyIds = [T1, T2, T3, T4, T5, T6, T7, T8, T9];
  const localListingIds = [L1, L2, L3, L4, L5, L6, L7, L8, L9];

  await prisma.recurringCharge.deleteMany({ where: { tenancyId: { in: localTenancyIds } } });
  await prisma.tenancy.deleteMany({ where: { id: { in: [...localTenancyIds, T_FOREIGN] } } });
  await prisma.unitReservation.deleteMany({ where: { organizationId: ORG, unitId: { in: [L1, L2, L7, L8, L9] } } }); // Restrict on Listing — must precede listing delete
  await prisma.aircondMeter.deleteMany({ where: { unitId: { in: [...localListingIds, L_FOREIGN] } } });
  await prisma.listing.deleteMany({ where: { id: { in: [...localListingIds, L_FOREIGN] } } });
  await prisma.apartment.deleteMany({ where: { id: { in: [APT, OTHER_APT] } } });
  await prisma.party.deleteMany({ where: { id: { in: [PARTY, OTHER_PARTY] } } });
  await prisma.property.deleteMany({ where: { id: OTHER_PROPERTY } });
  await prisma.organization.deleteMany({ where: { id: OTHER_ORG } });
});

d("resolveRoomRatesBatch", () => {
  it("B1 — an active AircondMeter's own rate is returned, configured:true", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L1]);
    expect(map.get(L1)).toEqual({ ratePerKwh: 0.55, configured: true });
  });

  it("B2 — a RETIRED (isActive:false) meter's OWN rate still wins — meter parity, NOT the 0.6 default", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L2]);
    expect(map.get(L2)).toEqual({ ratePerKwh: 0.55, configured: true });
  });

  it("B3 — a room with NO AircondMeter row at all lazy-defaults to 0.6, configured:false", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L3]);
    expect(map.get(L3)).toEqual({ ratePerKwh: 0.6, configured: false });
  });

  it("B4 — an empty listingIds array short-circuits: empty map, ZERO aircondMeter.findMany calls", async () => {
    const { spy, restore } = spyCallthrough(prisma.aircondMeter, "findMany");
    try {
      const map = await resolveRoomRatesBatch(prisma, ORG, []);
      expect(map.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("B5 — a foreign-org meter is not leaked: the local org sees the lazy default, not the foreign rate", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L_FOREIGN]);
    // Total-map contract: L_FOREIGN is still PRESENT (unlike the rent loader's
    // partial map, B12) — just resolved to the default, never OTHER_ORG's 0.99.
    expect(map.has(L_FOREIGN)).toBe(true);
    expect(map.get(L_FOREIGN)).toEqual({ ratePerKwh: 0.6, configured: false });
  });

  it("B6 — a meter whose rate happens to equal the lazy default (0.6) is still configured:true (row-exists, not value-differs)", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L6]);
    expect(map.get(L6)).toEqual({ ratePerKwh: 0.6, configured: true });
  });

  it("B7 — a duplicate listingId in the input collapses to one map entry (still correct, still one query)", async () => {
    const map = await resolveRoomRatesBatch(prisma, ORG, [L1, L1]);
    expect(map.size).toBe(1);
    expect(map.get(L1)).toEqual({ ratePerKwh: 0.55, configured: true });
  });
});

d("resolveRoomRentsBatch", () => {
  it("R1 — a reservation-linked, fully-occupied tenancy resolves to the reservation's agreedMonthlyRent", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T1], PERIOD);
    expect(map.get(T1)).toBe("1800.00");
  });

  it("R2 — two active rent RecurringCharges + a reservation: the LOWEST-id RC (500) wins over the higher-id RC (700) AND the reservation (2000)", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T2], PERIOD);
    expect(map.get(T2)).toBe("500.00");
  });

  it("R3 — no RC, no reservation: falls back to Tenancy.monthlyRentAmount, fully occupied", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T3], PERIOD);
    expect(map.get(T3)).toBe("1200.00");
  });

  it("R4 — mid-month start (no RC/reservation) prorates: round2(3000 * 16/31) = 1548.39", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T4], PERIOD);
    expect(map.get(T4)).toBe("1548.39");
  });

  it("R5 — occupancy window entirely BEFORE the period (past move-out) resolves to 0.00", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T5], PERIOD);
    expect(map.get(T5)).toBe("0.00");
  });

  it("R6 — occupancy window entirely AFTER the period (future move-in) resolves to 0.00", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T6], PERIOD);
    expect(map.get(T6)).toBe("0.00");
  });

  it("R7 — a reservation row EXISTS but agreedMonthlyRent is NULL: falls back to Tenancy.monthlyRentAmount, not '0.00' and not a crash", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T7], PERIOD);
    expect(map.get(T7)).toBe("1100.00");
  });

  it("R8 — an INACTIVE rent RecurringCharge is ignored: the reservation wins, not the stale RC", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T8], PERIOD);
    expect(map.get(T8)).toBe("1600.00");
  });

  it("R9 — an ACTIVE but non-rent RecurringCharge (chargeType:utility) is ignored: the reservation wins", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T9], PERIOD);
    expect(map.get(T9)).toBe("1700.00");
  });

  it("R10 — an empty tenancyIds array short-circuits: empty map, ZERO tenancy.findMany/recurringCharge.findMany calls", async () => {
    const tenancySpy = spyCallthrough(prisma.tenancy, "findMany");
    const rcSpy = spyCallthrough(prisma.recurringCharge, "findMany");
    try {
      const map = await resolveRoomRentsBatch(prisma, ORG, [], PERIOD);
      expect(map.size).toBe(0);
      expect(tenancySpy.spy).not.toHaveBeenCalled();
      expect(rcSpy.spy).not.toHaveBeenCalled();
    } finally {
      tenancySpy.restore();
      rcSpy.restore();
    }
  });

  it("R11 — a foreign-org tenancyId is absent from the result map (never resolved as this org's rent)", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T_FOREIGN], PERIOD);
    expect(map.has(T_FOREIGN)).toBe(false);
  });

  it("R12 — a duplicate tenancyId in the input collapses to one map entry", async () => {
    const map = await resolveRoomRentsBatch(prisma, ORG, [T1, T1], PERIOD);
    expect(map.size).toBe(1);
    expect(map.get(T1)).toBe("1800.00");
  });
});

d("batch loaders — N+1 discipline", () => {
  it("N1 — 5 listingIds + 5 tenancyIds in one round issue exactly ONE aircondMeter.findMany + ONE tenancy.findMany + ONE recurringCharge.findMany, never per-id", async () => {
    const meterSpy = spyCallthrough(prisma.aircondMeter, "findMany");
    const tenancySpy = spyCallthrough(prisma.tenancy, "findMany");
    const rcSpy = spyCallthrough(prisma.recurringCharge, "findMany");
    try {
      await resolveRoomRatesBatch(prisma, ORG, [L1, L2, L3, L4, L5]);
      await resolveRoomRentsBatch(prisma, ORG, [T1, T2, T3, T4, T5], PERIOD);
      expect(meterSpy.spy).toHaveBeenCalledTimes(1);
      expect(tenancySpy.spy).toHaveBeenCalledTimes(1);
      expect(rcSpy.spy).toHaveBeenCalledTimes(1);
    } finally {
      meterSpy.restore();
      tenancySpy.restore();
      rcSpy.restore();
    }
  });
});
