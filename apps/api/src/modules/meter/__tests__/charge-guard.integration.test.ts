// apps/api/src/modules/meter/__tests__/charge-guard.integration.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { chargeUtilityBillService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c2200000-0000-4000-8000-000000000001";
const USER = "c2200000-0000-4000-8000-000000000002";
const PROP = "c2200000-0000-4000-8000-000000000003";
const APT = "c2200000-0000-4000-8000-000000000004";
const ROOM = "c2200000-0000-4000-8000-000000000005";
const OWNER = "c2200000-0000-4000-8000-000000000006";
const TENANT = "c2200000-0000-4000-8000-000000000007";
const TEN = "c2200000-0000-4000-8000-000000000008";
const sess = { orgId: ORG, userId: USER, role: "manager", userType: "operator" } as never;

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.utilityAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.meterReading.deleteMany({ where: { organizationId: ORG } });
  await db.aircondMeter.deleteMany({ where: { organizationId: ORG } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
  await db.managementFeeConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "G", slug: "g", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "g@example.test", fullName: "G", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "T-1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const meter = await db.aircondMeter.create({ data: { organizationId: ORG, unitId: ROOM, ratePerKwh: "0.6000", isActive: true } });
  await db.meterReading.create({ data: { organizationId: ORG, meterId: meter.id, unitId: ROOM, periodMonth: new Date(Date.UTC(2026, 5, 1)), previousReading: "0.00", currentReading: "40.35", consumption: "40.35", ratePerKwh: "0.6000", computedAmount: "24.21", status: "submitted", submittedBy: USER } });
}
async function makeDraftBill(): Promise<string> {
  const db = getDb();
  const bill = await db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: new Date(Date.UTC(2026, 5, 1)), billingMode: "no_subsidy", tnbTotal: "24.21", airSelangor: "6.50", indahWater: "0.00", cleaning: "100.00", status: "draft", createdBy: USER } });
  return bill.id;
}

beforeAll(() => { process.env.ENABLE_PHASE2_OWNER_BILLING = "1"; });
afterAll(() => { delete process.env.ENABLE_PHASE2_OWNER_BILLING; });

dn("charge guard (integration)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  it("blocks posting with 422 OWNER_BILLING_NOT_CONFIGURED and writes zero charges", async () => {
    const billId = await makeDraftBill();
    const r = await chargeUtilityBillService(sess, billId, {});
    expect(r).toMatchObject({ ok: false, status: 422, error: "OWNER_BILLING_NOT_CONFIGURED" });
    expect(await getDb().charge.count({ where: { organizationId: ORG } })).toBe(0);
    expect((await getDb().unitUtilityBill.findFirstOrThrow({ where: { id: billId } })).status).toBe("draft");
  });

  it("blocks posting with 422 OWNER_NOT_ASSIGNED when the apartment has no owner", async () => {
    await getDb().listing.update({ where: { id: ROOM }, data: { ownerPartyId: null } });
    const billId = await makeDraftBill();
    const r = await chargeUtilityBillService(sess, billId, {});
    expect(r).toMatchObject({ ok: false, status: 422, error: "OWNER_NOT_ASSIGNED" });
    expect(await getDb().charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("posts normally once the owner has an active fee config", async () => {
    await getDb().managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true } });
    const billId = await makeDraftBill();
    const r = await chargeUtilityBillService(sess, billId, {});
    expect(r.ok).toBe(true);
    expect(await getDb().charge.count({ where: { organizationId: ORG } })).toBeGreaterThan(0);
  });
});
