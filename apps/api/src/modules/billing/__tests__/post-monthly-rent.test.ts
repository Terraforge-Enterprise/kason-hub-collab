import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { computeProratedRent, postMonthlyRentForTenancy, resolveMonthlyRentAmount } from "../post-monthly-rent";

// ── Pure proration math (always runs, no DB) ────────────────────────────────
describe("computeProratedRent", () => {
  const june = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01, June has 30 days

  it("full month when the tenancy started in an earlier month", () => {
    expect(computeProratedRent(1000, new Date(Date.UTC(2026, 0, 1)), null, june)).toBe(1000);
  });

  it("full month when the tenancy started on the 1st of the billed month", () => {
    expect(computeProratedRent(1000, new Date(Date.UTC(2026, 5, 1)), null, june)).toBe(1000);
  });

  it("pro-rates a mid-month start (spec example: 980 × 16/30 = 522.67)", () => {
    // June-15 start → occupiedDays = 30 − 15 + 1 = 16.
    expect(computeProratedRent(980, new Date(Date.UTC(2026, 5, 15)), null, june)).toBe(522.67);
  });

  it("pro-rates a last-day start to a single day", () => {
    // June-30 start → occupiedDays = 30 − 30 + 1 = 1 → 1000 × 1/30 = 33.33.
    expect(computeProratedRent(1000, new Date(Date.UTC(2026, 5, 30)), null, june)).toBe(33.33);
  });

  // ── R9: move-out (endDate) clamp ────────────────────────────────────────
  it("same-month move-out prorates start→end inclusive (2800 × 20/31)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6)), new Date(Date.UTC(2026, 6, 25)), july)).toBe(1806.45);
  });

  it("open-ended (null end) keeps month-end proration (2800 × 26/31)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6)), null, july)).toBe(2348.39);
  });

  it("month fully outside [start,end] yields 0 occupied days", () => {
    const sep = new Date(Date.UTC(2026, 8, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6)), new Date(Date.UTC(2026, 6, 25)), sep)).toBe(0);
  });

  it("endDate the day before the queried month starts yields 0 (not −1)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 5, 30)), july)).toBe(0);
  });

  it("endDate exactly on month-end still bills the full month", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 6, 31)), july)).toBe(2800);
  });

  it("single-day tenancy (start==end) prorates to exactly one day", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 15)), new Date(Date.UTC(2026, 6, 15)), july)).toBe(90.32);
  });

  it("month before the tenancy's start date yields 0 (not a full charge)", () => {
    const juneOnly = new Date(Date.UTC(2026, 5, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6)), null, juneOnly)).toBe(0);
  });

  it("end date earlier than start date (bad data) clamps to 0, not negative", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 25)), new Date(Date.UTC(2026, 6, 6)), july)).toBe(0);
  });

  // ── Time-of-day immunity (review R9 findings 1+2): Tenancy.startDate/endDate are bare
  // DateTime (not @db.Date), and a real writer (the Excel data importer) stores a
  // non-midnight startDate. Proration must be driven by UTC calendar day, never raw ms. ──
  it("non-midnight startDate (13:00 UTC) prorates identically to the midnight case (2800 × 26/31)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6, 13, 0, 0)), null, july)).toBe(2348.39);
  });

  it("non-midnight startDate (23:59:59 UTC) still prorates by calendar day, not clock time (2800 × 26/31)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(computeProratedRent(2800, new Date(Date.UTC(2026, 6, 6, 23, 59, 59)), null, july)).toBe(2348.39);
  });

  it("non-midnight endDate (13:00 UTC) whose calendar day is before the queried month yields 0, not a spurious day", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(
      computeProratedRent(2800, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 5, 30, 13, 0, 0)), july),
    ).toBe(0);
  });

  it("non-midnight endDate (20:00 UTC) prorates the true elapsed calendar days without tripping the full-rent shortcut (2800 × 30/31)", () => {
    const july = new Date(Date.UTC(2026, 6, 1));
    expect(
      computeProratedRent(2800, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 6, 30, 20, 0, 0)), july),
    ).toBe(2709.68);
  });
});

// ── Idempotent posting (DB-touching; gated on RUN_INTEGRATION) ───────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "d3000000-0000-4000-8000-000000000001";
const USER = "d3000000-0000-4000-8000-000000000002";
const PROP = "d3000000-0000-4000-8000-000000000003";
const APT = "d3000000-0000-4000-8000-000000000004";
const ROOM = "d3000000-0000-4000-8000-000000000005";
const PARTY = "d3000000-0000-4000-8000-000000000006";
const TEN = "d3000000-0000-4000-8000-000000000007";
const RESV = "d3000000-0000-4000-8000-000000000008";

async function cleanup() {
  const db = getDb();
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// Seed org + property + apartment + listing + party + an active tenancy.
// `opts.startDate` controls proration; `opts.agreedMonthlyRent` (when set) links a
// reservation whose rent must win over Tenancy.monthlyRentAmount.
async function seed(opts: { startDate?: Date; monthlyRentAmount?: string; agreedMonthlyRent?: string | null } = {}) {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "TR", slug: "tr", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY } });
  let reservationId: string | null = null;
  if (opts.agreedMonthlyRent !== undefined) {
    await db.unitReservation.create({
      data: {
        id: RESV, organizationId: ORG, referenceCode: "R-1", issuedByPartyId: PARTY, expiresAt: new Date(Date.UTC(2027, 0, 1)),
        publicToken: "tok-trent-1", propertyId: PROP, unitId: ROOM, proposedMoveIn: new Date(Date.UTC(2026, 5, 1)),
        reservationDeposit: "0.00", documentationFee: "0.00", rentalDeposit: "0.00", utilityDeposit: "0.00", accessCardDeposit: "0.00",
        agreedMonthlyRent: opts.agreedMonthlyRent,
      },
    });
    reservationId = RESV;
  }
  await db.tenancy.create({
    data: {
      id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-1",
      status: "active", billingStatus: "current", startDate: opts.startDate ?? new Date(Date.UTC(2026, 0, 1)),
      monthlyRentAmount: opts.monthlyRentAmount ?? "1000.00", numberOfPax: 1, reservationId,
    },
  });
}

dn("postMonthlyRentForTenancy (integration)", () => {
  const june = new Date(Date.UTC(2026, 5, 1));
  const EXPECTED_NUMBER = `RENT-202606-${TEN}`;

  beforeEach(async () => { await cleanup(); });

  it("creates a posted rent charge using the reservation's agreedMonthlyRent (full id charge number)", async () => {
    await seed({ agreedMonthlyRent: "980.00" }); // reservation 980 must win over monthlyRentAmount 1000
    const db = getDb();
    const res = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    expect(res.created).toBe(true);

    const charges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(charges.length).toBe(1);
    const c = charges[0];
    expect(c.chargeNumber).toBe(EXPECTED_NUMBER);
    expect(c.status).toBe("posted");
    expect(c.postedAt).not.toBeNull();
    expect(Number(c.amount)).toBe(980); // agreedMonthlyRent, NOT the 1000 monthlyRentAmount
    expect(Number(c.outstandingAmount)).toBe(980);
    expect(c.billingMonth?.toISOString().slice(0, 10)).toBe("2026-06-01");
    // a charge_created + charge_posted event pair was recorded
    const events = await db.chargeEvent.findMany({ where: { organizationId: ORG, chargeId: c.id } });
    expect(events.map((e) => e.eventType).sort()).toEqual(["charge_created", "charge_posted"]);
  });

  it("is idempotent: a second call does not duplicate the rent charge", async () => {
    await seed({ agreedMonthlyRent: "980.00" });
    const db = getDb();
    const first = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    const second = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.chargeId).toBe(second.chargeId);
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "rent" } })).toBe(1);
  });

  it("falls back to Tenancy.monthlyRentAmount when there is no reservation", async () => {
    await seed({ monthlyRentAmount: "1500.00" }); // no agreedMonthlyRent key → no reservation
    const db = getDb();
    await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    const c = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(Number(c.amount)).toBe(1500);
  });

  it("flips an existing cron-made DRAFT to posted without rewriting its amount", async () => {
    await seed({ agreedMonthlyRent: "980.00" });
    const db = getDb();
    // Simulate the auto-draft cron having created the rent as a DRAFT first (same full-id number).
    await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: EXPECTED_NUMBER, tenancyId: TEN, unitId: ROOM, partyId: PARTY,
        chargeType: "rent", status: "draft", description: "Monthly rent", dueDate: june, amount: "1234.00",
        currency: "MYR", outstandingAmount: "1234.00", attachmentKeys: [], billingMonth: june,
      },
    });
    const res = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    expect(res.created).toBe(false);
    const c = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(c.status).toBe("posted");
    expect(Number(c.amount)).toBe(1234); // amount preserved — NEVER rewritten on a flip
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "rent" } })).toBe(1);
  });

  it("pro-rates a mid-month start (980 × 16/30 = 522.67)", async () => {
    await seed({ startDate: new Date(Date.UTC(2026, 5, 15)), agreedMonthlyRent: "980.00" });
    const db = getDb();
    await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    const c = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(Number(c.amount)).toBe(522.67);
  });

  it("keeps every tenant-facing monthly charge as rent even when first month is owner-paid commission", async () => {
    // Move-in Jan 1 with the owner commission option. The tenant still owes rent.
    await seed({ startDate: new Date(Date.UTC(2026, 0, 1)) });
    const db = getDb();
    await db.tenancy.update({ where: { id: TEN }, data: { firstMonthIsCommission: true } });

    const jan = new Date(Date.UTC(2026, 0, 1));
    await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, jan, USER));
    const janCharge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, tenancyId: TEN, billingMonth: jan } });
    expect(janCharge.chargeType).toBe("rent");

    // Admin edits the move-in date to Feb 3 (dates-only) → the first full month is now March.
    await db.tenancy.update({ where: { id: TEN }, data: { startDate: new Date(Date.UTC(2026, 1, 3)) } });

    // A date edit must not change the tenant document into a commission invoice.
    const mar = new Date(Date.UTC(2026, 2, 1));
    await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, mar, USER));
    const marCharge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, tenancyId: TEN, billingMonth: mar } });
    expect(marCharge.chargeType).toBe("rent");
    expect(await db.charge.count({ where: { organizationId: ORG, tenancyId: TEN, chargeType: "letting_commission" } })).toBe(0);
  });
});

// ── Fix A: resolveMonthlyRentAmount + cron↔tracker convergence ───────────────
dn("resolveMonthlyRentAmount (integration)", () => {
  const june = new Date(Date.UTC(2026, 5, 1));

  beforeEach(async () => { await cleanup(); });

  it("returns prorated agreedMonthlyRent, not the Tenancy.monthlyRentAmount fallback", async () => {
    // Seed: monthlyRentAmount=1000, but the reservation says agreedMonthlyRent=980.
    // A mid-June-15 start means 16 occupied days → 980×16/30=522.67.
    await seed({ startDate: new Date(Date.UTC(2026, 5, 15)), monthlyRentAmount: "1000.00", agreedMonthlyRent: "980.00" });
    const db = getDb();
    const amount = await db.$transaction((tx) => resolveMonthlyRentAmount(tx, ORG, TEN, june));
    expect(amount).toBe("522.67"); // 980×16/30, not 1000
  });

  it("falls back to monthlyRentAmount when there is no reservation", async () => {
    await seed({ startDate: new Date(Date.UTC(2026, 5, 15)), monthlyRentAmount: "800.00" }); // no agreedMonthlyRent
    const db = getDb();
    const amount = await db.$transaction((tx) => resolveMonthlyRentAmount(tx, ORG, TEN, june));
    // 800×16/30 = 426.67
    expect(amount).toBe("426.67");
  });

  // Fix A convergence: the cron (via resolveMonthlyRentAmount) and the tracker
  // (postMonthlyRentForTenancy) must produce the SAME prorated amount in a
  // move-in month — so the draft→post flip preserves the correct amount.
  it("cron and tracker converge: draft created at resolveMonthlyRentAmount, tracker flips it without rewriting", async () => {
    await seed({ startDate: new Date(Date.UTC(2026, 5, 15)), agreedMonthlyRent: "980.00" });
    const db = getDb();
    const EXPECTED_NUMBER = `RENT-202606-${TEN}`;

    // Cron path: resolve the amount and create a draft (exactly as the cron does).
    const cronAmount = await db.$transaction((tx) => resolveMonthlyRentAmount(tx, ORG, TEN, june));
    expect(cronAmount).toBe("522.67"); // cron sees the prorated amount

    await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: EXPECTED_NUMBER, tenancyId: TEN, unitId: ROOM, partyId: PARTY,
        chargeType: "rent", status: "draft", description: "Monthly rent", dueDate: june,
        amount: cronAmount, currency: "MYR", outstandingAmount: cronAmount,
        attachmentKeys: [], billingMonth: june,
      },
    });

    // Tracker path: sees the cron draft, flips it to posted, preserves the amount.
    const res = await db.$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, june, USER));
    expect(res.created).toBe(false); // found the existing cron draft

    const c = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(c.status).toBe("posted");
    // The amount is the prorated value from the cron — NOT rewritten by the tracker.
    expect(Number(c.amount)).toBe(522.67);
    // Only one rent charge ever exists (no double-post).
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "rent" } })).toBe(1);
  });
});
