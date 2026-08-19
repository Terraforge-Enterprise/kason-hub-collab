/**
 * Task 8: grid read DTO exposes `invoicedAt` + `hasPaidInvoice` (net-of-reversal).
 *
 * getGridService enriches each row with:
 *  • invoicedAt — the entry's invoice-issued timestamp (null until a Bill issues docs).
 *  • hasPaidInvoice — TRUE iff a LIVE (ISSUED-document) charge for the entry carries a
 *    net-positive payment after subtracting its PaymentAllocationReversal sum. This is
 *    the SAME predicate the Task-6 server paid-freeze (anyChargePaid) enforces, computed
 *    for the whole page in a BOUNDED number of queries (entriesWithPaidInvoice) — no N+1.
 *
 * A fully-reversed payment nets to 0 and does NOT mark the entry paid (reversed-not-paid).
 *
 * Mirrors bill-rebill/bill-notify's fixture pattern: a dedicated fully-seeded org (never
 * the shared dev seed), ENABLE_PHASE2_BILLING_DOCS on, FK-safe ordered cleanup.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/grid-read-paid.integration.test.ts
 *
 * Coverage (behavior-inventory):
 *  • paid-flag         — an entry whose live tenant invoice has a net-positive payment →
 *                        row.hasPaidInvoice === true, row.invoicedAt is set.
 *  • reversed-not-paid — the only payment fully reversed → row.hasPaidInvoice === false
 *                        (invoicedAt still set): the reversal nets the payment out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, getGridService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace (b8800000) so cleanup is org-scoped + total.
const ORG = "b8800000-0000-4000-8000-000000000001";
const USER = "b8800000-0000-4000-8000-000000000002";
const PROP = "b8800000-0000-4000-8000-000000000003";
const APT = "b8800000-0000-4000-8000-000000000004";
const ROOM_A = "b8800000-0000-4000-8000-000000000005";
const ROOM_B = "b8800000-0000-4000-8000-000000000006";
const PARTY_A = "b8800000-0000-4000-8000-000000000007";
const PARTY_B = "b8800000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b8800000-0000-4000-8000-000000000009";
const TEN_A = "b8800000-0000-4000-8000-00000000000a";
const TEN_B = "b8800000-0000-4000-8000-00000000000b";
const PAYMENT = "b8800000-0000-4000-8000-00000000000c";

const PERIOD_STR = "2026-06-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
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

/** A PARTITIONED apartment: 2 occupied rooms (each own tenancy/party, pax 1) + owner.
 * Absorbed-TNB (owner-borne > 0) with tenant-borne wifi so a first Bill issues 2 IVTEN
 * + 1 IVOWN. Returns the entry's concurrency token. */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
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
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00", // charge-nature gate: this scaffolding WiFi is not what the test measures; "profit" reproduces the pre-gate null behaviour (manager_revenue → IVTEN) exactly
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/** Pay a live TENANT charge IN FULL. Returns the allocation id + amount so a test can
 * reverse it. Mirrors bill-rebill's paid-charge seeding. */
async function payOneTenantChargeInFull(): Promise<{ allocationId: string; amount: string }> {
  const db = getDb();
  const liveLines = await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED", counterpartyType: "tenant" } }, select: { chargeId: true } });
  const chargeId = liveLines.map((l) => l.chargeId).filter((x): x is string => !!x)[0];
  expect(chargeId).toBeTruthy();
  const charge = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { partyId: true, amount: true } });
  await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B8-1", partyId: charge.partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: charge.amount, currency: "MYR", receivedAt: new Date() } });
  const alloc = await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId, allocatedAmount: charge.amount, allocatedAt: new Date() }, select: { id: true } });
  return { allocationId: alloc.id, amount: charge.amount.toString() };
}

/** Read the grid and return the single row for the seeded apartment. */
async function readAptRow() {
  const g = await getGridService({ orgId: ORG }, { period: PERIOD_STR, months: 1 });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error("getGridService failed");
  const row = g.data.rows.find((r) => r.apartmentId === APT);
  expect(row).toBeTruthy();
  return row!;
}

dn("bills-grid read: invoicedAt + hasPaidInvoice (Task 8)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("paid-flag: an entry whose live invoice has a net-positive payment reads hasPaidInvoice=true and invoicedAt set", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    // Control: invoiced but unpaid → invoicedAt set, hasPaidInvoice false.
    const before = await readAptRow();
    expect(before.invoicedAt).not.toBeNull();
    expect(before.hasPaidInvoice).toBe(false);

    // Pay one live tenant invoice in full.
    await payOneTenantChargeInFull();

    const after = await readAptRow();
    expect(after.invoicedAt).not.toBeNull();
    expect(after.hasPaidInvoice).toBe(true);
  });

  it("reversed-not-paid: a fully-reversed payment nets out → hasPaidInvoice=false (invoicedAt still set)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry();

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    const { allocationId, amount } = await payOneTenantChargeInFull();
    // Sanity: paid before the reversal.
    expect((await readAptRow()).hasPaidInvoice).toBe(true);

    // Fully reverse the allocation → net allocated = 0.
    await db.paymentAllocationReversal.create({
      data: { organizationId: ORG, originalAllocationId: allocationId, amount, reason: "test full reversal", reversedById: USER, idempotencyKey: "rev-b8-1" },
    });

    const after = await readAptRow();
    expect(after.invoicedAt).not.toBeNull(); // still invoiced — reversal doesn't un-issue
    expect(after.hasPaidInvoice).toBe(false); // but the payment netted out
  });
});
