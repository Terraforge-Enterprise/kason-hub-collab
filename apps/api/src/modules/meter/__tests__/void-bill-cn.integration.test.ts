/**
 * voidUtilityBillService → CN cascade (integration, RUN_INTEGRATION=1).
 *
 * Proves (flag ON): voiding a charged bill issues ONE CN per affected charge
 * document (LHDN: one CN references one original), flips each charge to
 * `credited` with outstanding ZEROED (fixes the pre-P3 gap where meter void
 * skipped outstanding), flips allocations/readings/bill to void, and the
 * documentless legacy charge falls back to plain void.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/meter/__tests__/void-bill-cn.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { voidUtilityBillService } from "../service";
import type { SessionPayload } from "../../../lib/auth";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix 9c31)
const ORG = "9c310000-0000-4000-8000-000000000001";
const USER = "9c310000-0000-4000-8000-000000000002";
const TENANT = "9c310000-0000-4000-8000-000000000003";
const PROP = "9c310000-0000-4000-8000-000000000004";
const APT = "9c310000-0000-4000-8000-000000000005";
const UNIT = "9c310000-0000-4000-8000-000000000006";
const TEN = "9c310000-0000-4000-8000-000000000007";
const CAT = "9c310000-0000-4000-8000-000000000008";
const SERIES_DEP = "9c310000-0000-4000-8000-000000000009";
const SERIES_CN = "9c310000-0000-4000-8000-00000000000a";
const BILL = "9c310000-0000-4000-8000-00000000000b";
const C_UTIL = "9c310000-0000-4000-8000-00000000000c";
const D_UTIL = "9c310000-0000-4000-8000-00000000000d";
const C_LEGACY = "9c310000-0000-4000-8000-00000000000e";
const PERIOD = new Date(Date.UTC(2026, 5, 1));

const session = { orgId: ORG, userId: USER, role: "admin" } as SessionPayload;

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.utilityAllocation.deleteMany({ where: org });
  await db.meterReading.deleteMany({ where: org });
  await db.aircondMeter.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "P3 Meter Void Org", slug: "p3-meter-void-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "p3meter@test.local", passwordHash: "x", status: "active", role: "admin", fullName: "P3 Admin" },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Meter Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROP, organizationId: ORG, name: "P3 Tower", propertyCode: "P3-TWR", propertyType: "residential",
      addressLine1: "1 P3 Ave", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "P3-10-01", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.tenancy.create({
    data: {
      id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT,
      tenancyCode: "P3-T-01", status: "active", billingStatus: "current",
      startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRentAmount: "1000.00", numberOfPax: 1,
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DEP, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "utility_tnb", name: "Utility (TNB)",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES_DEP,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "utility_tnb",
      isSystem: true, active: true, sortOrder: 10,
    },
  });
  // Charged bill + one utility charge WITH a DEP document + one legacy aircond
  // charge WITHOUT a document (raised from a reading).
  await db.charge.create({
    data: {
      id: C_UTIL, organizationId: ORG, chargeNumber: "UTIL-202606-P3", partyId: TENANT,
      tenancyId: TEN, unitId: UNIT, chargeType: "utility", categoryId: CAT,
      status: "posted", postedAt: new Date(), dueDate: new Date(Date.UTC(2026, 5, 30)),
      amount: "80.00", currency: "MYR", outstandingAmount: "80.00", billingMonth: PERIOD,
    },
  });
  await db.billingDocument.create({
    data: {
      id: D_UTIL, organizationId: ORG, docType: "debit_note", documentNumber: "DEP-8001",
      seriesId: SERIES_DEP, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, tenancyId: TEN, apartmentId: APT, billingMonth: PERIOD,
      subtotal: "80.00", sstAmount: 0, total: "80.00",
      lines: {
        create: [{ chargeId: C_UTIL, categoryId: CAT, description: "Shared utilities 202606", amount: "80.00", sstRate: 0, sstAmount: 0 }],
      },
    },
  });
  await db.charge.create({
    data: {
      id: C_LEGACY, organizationId: ORG, chargeNumber: "AC-202606-P3", partyId: TENANT,
      tenancyId: TEN, unitId: UNIT, chargeType: "aircond", status: "posted",
      postedAt: new Date(), dueDate: new Date(Date.UTC(2026, 5, 30)),
      amount: "12.00", currency: "MYR", outstandingAmount: "12.00", billingMonth: PERIOD,
    },
  });
  await db.unitUtilityBill.create({
    data: {
      id: BILL, organizationId: ORG, apartmentId: APT, periodMonth: PERIOD,
      billingMode: "whole", tnbTotal: "80.00", airSelangor: "0.00", indahWater: "0.00",
      cleaning: "0.00", status: "charged", createdBy: USER,
    },
  });
  await db.utilityAllocation.create({
    data: {
      organizationId: ORG, billId: BILL, unitId: UNIT, tenancyId: TEN, partyId: TENANT,
      pax: 1, tnbShare: "80.00", airSelangorShare: "0.00", indahShare: "0.00",
      cleaningShare: "0.00", wifiShare: "0.00", subsidyDeduction: "0.00",
      computedAmount: "80.00", chargeId: C_UTIL, status: "charged",
    },
  });
  const db2 = getDb();
  await db2.aircondMeter.create({ data: { organizationId: ORG, unitId: UNIT, ratePerKwh: "0.6000", isActive: true } }).then(async (m) => {
    await db2.meterReading.create({
      data: {
        organizationId: ORG, meterId: m.id, unitId: UNIT, periodMonth: PERIOD,
        previousReading: "0.00", currentReading: "20.00", consumption: "20.00",
        ratePerKwh: "0.6000", computedAmount: "12.00", status: "charged",
        chargeId: C_LEGACY, submittedBy: USER,
      },
    });
  });
}

dn("voidUtilityBillService → CN cascade (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("flag ON: CN per document, credited + outstanding 0, legacy charge plain-voided, cascade flips", async () => {
    const r = await voidUtilityBillService(session, BILL, { reason: "wrong TNB figure" });
    expect(r.ok).toBe(true);

    const db = getDb();
    const util = await db.charge.findUniqueOrThrow({ where: { id: C_UTIL } });
    expect(util.status).toBe("credited");
    expect(Number(util.outstandingAmount.toString())).toBe(0); // the pre-P3 gap, now fixed

    const legacy = await db.charge.findUniqueOrThrow({ where: { id: C_LEGACY } });
    expect(legacy.status).toBe("void"); // no document → plain void fallback
    expect(Number(legacy.outstandingAmount.toString())).toBe(0);

    const cns = await db.billingDocument.findMany({ where: { organizationId: ORG, docType: "credit_note" } });
    expect(cns).toHaveLength(1); // one CN per affected DOCUMENT (legacy charge has none)
    expect(cns[0]!.originalDocumentId).toBe(D_UTIL);

    const original = await db.billingDocument.findUniqueOrThrow({ where: { id: D_UTIL } });
    expect(original.status).toBe("offset");

    const bill = await db.unitUtilityBill.findUniqueOrThrow({ where: { id: BILL } });
    expect(bill.status).toBe("void");
    const alloc = await db.utilityAllocation.findFirstOrThrow({ where: { organizationId: ORG, billId: BILL } });
    expect(alloc.status).toBe("void");
    const reading = await db.meterReading.findFirstOrThrow({ where: { organizationId: ORG, unitId: UNIT } });
    expect(reading.status).toBe("void");
    expect(reading.chargeId).toBeNull();
  });

  it("already-void bill → 409 ALREADY_VOID (unchanged)", async () => {
    const db = getDb();
    await db.unitUtilityBill.update({ where: { id: BILL, organizationId: ORG }, data: { status: "void" } });
    const r = await voidUtilityBillService(session, BILL, { reason: "double void" });
    expect(r).toMatchObject({ ok: false, status: 409, error: "ALREADY_VOID" });
  });
});
