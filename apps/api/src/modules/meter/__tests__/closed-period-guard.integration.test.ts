/**
 * R1 follow-up — closed-period write guard wired into the METER charge path
 * (`chargeUtilityBillService`), end-to-end (integration, RUN_INTEGRATION=1).
 *
 * MONEY: posting a utility bill feeds the owner ledger for the bill's period month
 * (owner-borne utilities + rent income) via the POST-COMMIT owner-ledger sync-hook.
 * If that owner-statement month is FROZEN, the sync-hook's void-only forward-reversal
 * silently drops the owner impact — so the posting MUST be rejected AT CREATION,
 * in-tx, before any charge/rent write. This proves the shared `assertPeriodOpen`
 * guard now does exactly that at this site, while leaving open months + the flag-off
 * path byte-identical.
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     npx vitest run src/modules/meter/__tests__/closed-period-guard.integration.test.ts --no-coverage
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { chargeUtilityBillService } from "../service";
import { ClosedPeriodError } from "../../owner-ledger/closed-period";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const LEDGER = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// Dedicated fixture ids (prefix c305 — unused by any other suite).
const ORG = "c3050000-0000-4000-8000-000000000001";
const USER = "c3050000-0000-4000-8000-000000000002";
const PROP = "c3050000-0000-4000-8000-000000000003";
const APT = "c3050000-0000-4000-8000-000000000004";
const ROOM = "c3050000-0000-4000-8000-000000000005";
const OWNER = "c3050000-0000-4000-8000-000000000006";
const TENANT = "c3050000-0000-4000-8000-000000000007";
const TEN = "c3050000-0000-4000-8000-000000000008";
const sess = { orgId: ORG, userId: USER, role: "manager", userType: "operator" } as never;

// The bill's period month + its first-of-month (UTC) OwnerStatementPeriod key.
const BILL_MONTH = new Date(Date.UTC(2026, 5, 1)); // 2026-06

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.unitMonthLedger.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.utilityAllocation.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.meterReading.deleteMany({ where: org });
  await db.aircondMeter.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Owner-assigned partitioned unit + one occupied tenancy + a submitted aircon
 *  reading + an ACTIVE fee config (so assertOwnerBillingReady passes). Mirrors
 *  charge-guard.integration.test.ts's seed. */
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "G305", slug: "g305", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "g305@example.test", fullName: "G305", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-305", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-305", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "T-305", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
  await db.meterReading.create({ data: { organizationId: ORG, meterId: meter.id, unitId: ROOM, periodMonth: BILL_MONTH, previousReading: "0.00", currentReading: "40.35", consumption: "40.35", ratePerKwh: "0.6000", computedAmount: "24.21", status: "submitted", submittedBy: USER } });
  // Active fee config so assertOwnerBillingReady passes (R2 readiness gate).
  await db.managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true } });
}

async function makeDraftBill(): Promise<string> {
  const db = getDb();
  const bill = await db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: BILL_MONTH, billingMode: "no_subsidy", tnbTotal: "24.21", airSelangor: "6.50", indahWater: "0.00", cleaning: "100.00", status: "draft", createdBy: USER } });
  return bill.id;
}

async function seedFrozenPeriod() {
  await getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null, // combined scope = the freeze unit
      periodMonth: BILL_MONTH,
      status: "frozen",
      idempotencyKey: `ownerstmt:${OWNER}:${BILL_MONTH.toISOString().slice(0, 7)}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

function setLedgerFlag(on: boolean) {
  if (on) process.env[LEDGER] = "1";
  else delete process.env[LEDGER];
}

dn("meter charge path — closed-period guard (integration)", () => {
  let savedLedger: string | undefined;
  beforeAll(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    savedLedger = process.env[LEDGER];
  });
  afterAll(() => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    if (savedLedger === undefined) delete process.env[LEDGER];
    else process.env[LEDGER] = savedLedger;
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
    setLedgerFlag(true); // default flag ON; the flag-off test overrides + restores
  });
  afterEach(async () => {
    await cleanup();
  });

  it("MT1: frozen owner-month + flag ON → chargeUtilityBillService throws ClosedPeriodError; zero charges; bill stays draft", async () => {
    const db = getDb();
    await seedFrozenPeriod();
    const billId = await makeDraftBill();
    await expect(chargeUtilityBillService(sess, billId, {})).rejects.toBeInstanceOf(ClosedPeriodError);
    // Whole posting tx rolled back — no charge, bill still draft (idempotency intact).
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).status).toBe("draft");
  });

  it("MT2: open owner-month + flag ON → posts normally; charges created", async () => {
    const db = getDb();
    // No frozen period seeded ⇒ the owner-month is open.
    const billId = await makeDraftBill();
    const r = await chargeUtilityBillService(sess, billId, {});
    expect(r.ok).toBe(true);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBeGreaterThan(0);
    expect((await db.unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).status).toBe("charged");
  });

  it("MT3: flag OFF into a frozen owner-month → still posts normally (byte-identical)", async () => {
    const db = getDb();
    await seedFrozenPeriod();
    setLedgerFlag(false);
    try {
      const billId = await makeDraftBill();
      const r = await chargeUtilityBillService(sess, billId, {});
      expect(r.ok).toBe(true);
      expect(await db.charge.count({ where: { organizationId: ORG } })).toBeGreaterThan(0);
    } finally {
      setLedgerFlag(true);
    }
  });
});
