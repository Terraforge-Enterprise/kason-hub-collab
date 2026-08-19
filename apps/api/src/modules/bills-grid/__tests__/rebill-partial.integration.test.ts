/**
 * Rule 4 boundary — the re-Bill payment block uses NET-OF-REVERSAL allocations.
 *
 * ANY active (non-reversed) tenant payment blocks re-Bill (covered by
 * rebill-mechanism tests 4/5). This file pins the boundary that Task 8's removed
 * reversal path used to occupy: a FULLY-REVERSED allocation nets to zero and must NOT
 * block — the re-Bill proceeds (confirmation → reinvoiced). So a payment that was
 * already reversed through the accounting process does not permanently freeze the row.
 *
 * Real local Postgres only. Period = the org-local CURRENT month.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/rebill-partial.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "b7800000-0000-4000-8000-000000000001";
const USER = "b7800000-0000-4000-8000-000000000002";
const PROP = "b7800000-0000-4000-8000-000000000003";
const APT = "b7800000-0000-4000-8000-000000000004";
const ROOM_A = "b7800000-0000-4000-8000-000000000005";
const ROOM_B = "b7800000-0000-4000-8000-000000000006";
const PARTY_A = "b7800000-0000-4000-8000-000000000007";
const PARTY_B = "b7800000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7800000-0000-4000-8000-000000000009";
const TEN_A = "b7800000-0000-4000-8000-00000000000a";
const TEN_B = "b7800000-0000-4000-8000-00000000000b";
const PAYMENT = "b7800000-0000-4000-8000-00000000000c";

const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedPartitionedEntry(): Promise<void> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG8", slug: "bg8", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg8@example.test", fullName: "BG8 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B8", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B8", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
}

async function token(): Promise<string> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  return e.updatedAt.toISOString();
}
async function amendWifi(wifi: string): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi } });
}
async function bill(confirm?: boolean) {
  const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await token(), confirmRebill: confirm }] });
  if (!r.ok) throw new Error("not ok");
  return r.data.results[0];
}

dn("bills-grid re-Bill payment block — net-of-reversal boundary (rule 4)", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("a FULLY-REVERSED payment (net zero) does NOT block re-Bill — it proceeds to reinvoiced", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seedPartitionedEntry();
    const first = await bill();
    expect(first.outcome).toBe("invoiced");

    // Pay one live tenant charge in full…
    const paidChargeId = (await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED", counterpartyType: "tenant" } }, select: { chargeId: true } }))
      .map((l) => l.chargeId).filter((x): x is string => !!x)[0];
    const ch = await db.charge.findUniqueOrThrow({ where: { id: paidChargeId }, select: { partyId: true, amount: true } });
    await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B8-1", partyId: ch.partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: ch.amount, currency: "MYR", receivedAt: new Date() } });
    const alloc = await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: paidChargeId, allocatedAmount: ch.amount, allocatedAt: new Date() }, select: { id: true } });
    // …then FULLY reverse it (the accounting reversal process) → net allocation = 0.
    await db.paymentAllocationReversal.create({ data: { organizationId: ORG, originalAllocationId: alloc.id, amount: ch.amount, reason: "accounting reversal", reversedById: USER, idempotencyKey: `test-rev-${alloc.id}` } });

    // Re-Bill is NOT blocked (rule 4 uses net-of-reversal): confirmation → reinvoiced.
    await amendWifi("240.00");
    const needsConfirm = await bill();
    expect(needsConfirm.outcome).toBe("rebill_confirmation_required");
    const r = await bill(true);
    expect(r.outcome).toBe("reinvoiced");
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
  });
});
