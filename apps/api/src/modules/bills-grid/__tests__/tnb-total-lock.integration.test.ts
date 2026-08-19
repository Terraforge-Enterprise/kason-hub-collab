/**
 * Server-side guard on `tnbTotal` once the electricity is paid.
 *
 * Reported on UAT: the "Owner" cell under the TNB band stayed editable after the tenant paid
 * their electricity. The render bug is fixed in the client (row-lock.ts `CELL_BUCKET`), but
 * the client was the ONLY thing standing in the way — `saveEntryService`'s existing
 * ENTRY_LOCKED check reads the MANUAL `paymentStatus` column, which is deliberately never
 * advanced by a Bill or a payment, so a direct API call was accepted.
 *
 * That matters because `tnbTotal` is not an owner-only figure: it is the whole TNB bill, and
 * every occupied room's tenant share is derived from it (meter/compute.ts). Changing it after
 * the electricity settles rewrites what an already-paid charge "should" have been.
 *
 * The guard is per-FIELD, not entry-wide — re-freezing the month would undo partial re-Bill.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded local TEST_DATABASE_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { saveEntryService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "e3300000-0000-4000-8000-000000000001";
const USER = "e3300000-0000-4000-8000-000000000002";
const PROP = "e3300000-0000-4000-8000-000000000003";
const APT = "e3300000-0000-4000-8000-000000000004";
const ROOM = "e3300000-0000-4000-8000-000000000005";
const PARTY = "e3300000-0000-4000-8000-000000000006";
const TEN = "e3300000-0000-4000-8000-000000000007";
const PAYMENT = "e3300000-0000-4000-8000-000000000008";
const SERIES = "e3300000-0000-4000-8000-000000000009";
const CAT = "e3300000-0000-4000-8000-00000000000a";

const PERIOD = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_STR = "2026-09-01";
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "TL", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "tl@t.test", fullName: "TL", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-TL", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-TL", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-TL", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "electricity_tenant", name: "Electricity", family: "tenant_income", docType: "invoice", seriesId: SERIES, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });
}

/** Save a scalar through the real service; returns the Result. */
function save(body: Record<string, unknown>) {
  return saveEntryService(session, APT, { period: PERIOD_STR, ...body } as never);
}

async function entryId(): Promise<string> {
  const e = await getDb().unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG } });
  return e.id;
}

/**
 * Settle this entry's electricity with cash.
 *
 * `outstandingAmount: "0.00"` AND a net-positive allocation, both — an allocation without a
 * settled charge is the phantom shape a previous fixture used, and it let tests pass for the
 * wrong reason.
 */
async function payElectricity() {
  const db = getDb();
  const charge = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: "GRIDUTIL-202609-TL-ELECTRICITY", chargeType: "utility",
      partyId: PARTY, unitId: ROOM, amount: "80.00", outstandingAmount: "0.00",
      status: "paid", currency: "MYR", dueDate: PERIOD, billingMonth: PERIOD,
      sourceGridEntryId: await entryId(), categoryId: CAT,
    },
    select: { id: true, amount: true },
  });
  await db.payment.create({
    data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-TL", partyId: PARTY, paymentType: "incoming", paymentMethod: "cash", status: "posted", amount: charge.amount, currency: "MYR", receivedAt: new Date() },
  });
  await db.paymentAllocation.create({
    data: { organizationId: ORG, paymentId: PAYMENT, chargeId: charge.id, allocatedAmount: charge.amount, allocatedAt: new Date() },
  });
}

dn("tnbTotal write guard once electricity is paid", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
    expect((await save({ tnbTotal: "150.00", wifi: "60.00" })).ok).toBe(true);
  });
  afterEach(cleanup);

  it("refuses a CHANGE to tnbTotal after the electricity settles", async () => {
    // The hole this closes: the manual paymentStatus column is still "unpaid" here — exactly
    // the state the pre-existing ENTRY_LOCKED check waves through — yet real money has landed.
    await payElectricity();

    const r = await save({ tnbTotal: "200.00" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toBe("ENTRY_LOCKED");

    // And it did not write: the stored raw column is untouched.
    const e = await getDb().unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(Number(e.tnbTotalRaw)).toBe(150);
  });

  it("still allows an UNCHANGED echo of the same tnbTotal", async () => {
    // A full-row save that happens to carry the current value must not 409 — the guard is
    // about re-pricing, and re-sending the same number re-prices nothing.
    await payElectricity();
    expect((await save({ tnbTotal: "150.00" })).ok).toBe(true);
  });

  it("leaves OTHER scalars on the same month amendable", async () => {
    // Per-field, not entry-wide. Re-freezing the whole month is the behaviour partial re-Bill
    // exists to remove, so paid electricity must not lock the WiFi.
    await payElectricity();

    expect((await save({ wifi: "75.00" })).ok).toBe(true);
    const e = await getDb().unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(Number(e.wifi)).toBe(75);
  });

  it("leaves tnbTotal editable while the electricity is UNPAID", async () => {
    // Billed-but-unpaid stays amendable (spec R7) — no payment here at all, so nothing freezes.
    expect((await save({ tnbTotal: "175.00" })).ok).toBe(true);
    const e = await getDb().unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(Number(e.tnbTotalRaw)).toBe(175);
  });
});
