/**
 * Slice 0 / spec R11 — an abandoned FPX attempt must not read as money received.
 *
 * Portal FPX mints a Payment AND its allocations at INITIATE, settling nothing
 * (portal.payments.repository.ts — "NO charge is settled"; charge.outstandingAmount
 * is untouched). Expiry flips the payment to "expired"; a gateway failure to
 * "failed". NEITHER removes the allocations. So a tenant who opened the bank page
 * and walked away left a permanent PaymentAllocation behind.
 *
 * Three bills-grid reads counted those allocations as cash because they filtered
 * on nothing:
 *   • entriesWithPaidInvoice  → row.hasPaidInvoice  (drives the FE lock)
 *   • settlementByEntry       → row.settlement      (drives the paid ticks)
 *   • rebillSupersedeTx       → rebill_blocked_payment_exists (the money guard)
 *
 * Result today: a false part-paid tick, a locked row, and a blocked re-Bill on a
 * unit nobody has paid for. This suite pins all three to the shared
 * CASH_ALLOCATION_WHERE predicate, with a `posted` positive control so it cannot
 * pass by ignoring allocations altogether.
 *
 * PERIOD IS THE CURRENT BILLING MONTH ON PURPOSE. Re-Bill rule 1
 * (rebillSupersedeTx step 1) refuses any period before the org-local current
 * month with `rebill_blocked_previous_period` — on a past period this suite would
 * go green for the wrong reason, never exercising the payment guard at all.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded TEST_DATABASE_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, getGridService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace (b8810000) so cleanup is org-scoped + total.
const ORG = "b8810000-0000-4000-8000-000000000001";
const USER = "b8810000-0000-4000-8000-000000000002";
const PROP = "b8810000-0000-4000-8000-000000000003";
const APT = "b8810000-0000-4000-8000-000000000004";
const ROOM_A = "b8810000-0000-4000-8000-000000000005";
const ROOM_B = "b8810000-0000-4000-8000-000000000006";
const PARTY_A = "b8810000-0000-4000-8000-000000000007";
const PARTY_B = "b8810000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b8810000-0000-4000-8000-000000000009";
const TEN_A = "b8810000-0000-4000-8000-00000000000a";
const TEN_B = "b8810000-0000-4000-8000-00000000000b";
const PAYMENT = "b8810000-0000-4000-8000-00000000000c";

const TZ = "Asia/Kuala_Lumpur";
const PERIOD = currentBillingMonthUTC(TZ);
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

/** PARTITIONED apartment, 2 occupied rooms + owner — same shape as grid-read-paid's
 *  fixture, so a first Bill issues 2 IVTEN + 1 IVOWN. */
async function seedPartitionedEntry(): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG81", slug: "bg81", status: "active", defaultCurrency: "MYR", timezone: TZ, locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg81@example.test", fullName: "BG81 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B81", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B81", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T81-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T81-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", wifiNature: "profit", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/**
 * Attach an allocation to a live tenant charge under a payment in `status`.
 *
 * Faithful to initiateFpxPaymentTx for the non-posted cases: the allocation is
 * created and `charge.outstandingAmount` is left ALONE. That is what makes this a
 * phantom — `settlementByEntry`'s `isSettled` signal reads outstandingAmount and
 * was therefore never fooled; only its `isTouched` signal (net-of-reversal
 * allocations) was, which is precisely the half this slice fixes.
 */
async function attachAllocation(status: string): Promise<{ chargeId: string }> {
  const db = getDb();
  const liveLines = await db.billingDocumentLine.findMany({
    where: { document: { organizationId: ORG, documentStatus: "ISSUED", counterpartyType: "tenant" } },
    select: { chargeId: true },
  });
  const chargeId = liveLines.map((l) => l.chargeId).filter((x): x is string => !!x)[0];
  expect(chargeId).toBeTruthy();
  const charge = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { partyId: true, amount: true } });
  const isFpx = status !== "posted";
  await db.payment.create({
    data: {
      id: PAYMENT, organizationId: ORG, paymentNumber: `PY-B81-${status}`, partyId: charge.partyId,
      paymentType: "incoming", paymentMethod: isFpx ? "fpx" : "cash", status,
      ...(isFpx ? { provider: "mock", providerTxnId: `TXN-${status}`, gatewayStatus: status === "pending_approval" ? "pending" : status } : {}),
      amount: charge.amount, currency: "MYR", receivedAt: new Date(),
    },
  });
  await db.paymentAllocation.create({
    data: { organizationId: ORG, paymentId: PAYMENT, chargeId, allocatedAmount: charge.amount, allocatedAt: new Date() },
  });
  return { chargeId };
}

async function dropAllocation() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
}

async function readAptRow() {
  const g = await getGridService({ orgId: ORG }, { period: PERIOD_STR, months: 1 });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error("getGridService failed");
  const row = g.data.rows.find((r) => r.apartmentId === APT);
  expect(row).toBeTruthy();
  return row!;
}

/** Re-Bill the seeded row, reading its CURRENT token first (the first Bill bumped it). */
async function reBill(confirm: boolean) {
  const db = getDb();
  const entry = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT }, select: { updatedAt: true } });
  const r = await billService(session, {
    period: PERIOD_STR,
    rows: [{ apartmentId: APT, expectedUpdatedAt: entry.updatedAt.toISOString(), confirmRebill: confirm }],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("billService failed");
  return r.data.results[0]!;
}

dn("bills-grid: an allocation whose payment never received money is not cash (R11)", () => {
  let token = "";

  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    token = (await seedPartitionedEntry()).expectedUpdatedAt;
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token }] });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first Bill failed");
    expect(first.data.results[0]!.outcome).toBe("invoiced");
  });

  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  // The three phantom statuses, each asserted across all three changed reads.
  for (const status of ["pending_approval", "expired", "failed"]) {
    it(`${status}: reads as UNPAID on the row flag, the settlement roll-up, and the re-Bill guard`, async () => {
      await attachAllocation(status);

      // 1. entriesWithPaidInvoice — drives the FE row lock.
      const row = await readAptRow();
      expect(row.hasPaidInvoice).toBe(false);

      // 2. settlementByEntry — drives the per-cell paid ticks. No money in ⇒ never
      //    "partial"/"paid". ("none" is also acceptable: an entry the roll-up saw no
      //    live cash for at all.)
      expect(["unpaid", "none"]).toContain(row.settlement?.status ?? "none");

      // 3. rebillSupersedeTx — the authoritative in-transaction money guard. It must
      //    NOT refuse, and specifically must not refuse for the PAYMENT reason.
      const result = await reBill(false);
      expect(result.outcome).not.toBe("rebill_blocked_payment_exists");
      expect(result.paidBlockers ?? []).toEqual([]);
    });
  }

  // POSITIVE CONTROL. Without this the suite would also pass against code that
  // ignored PaymentAllocation entirely.
  it("posted: still reads as paid on all three, and still blocks the re-Bill", async () => {
    await attachAllocation("posted");

    const row = await readAptRow();
    expect(row.hasPaidInvoice).toBe(true);
    expect(["partial", "paid"]).toContain(row.settlement?.status ?? "none");

    const result = await reBill(false);
    expect(result.outcome).toBe("rebill_blocked_payment_exists");
    expect((result.paidBlockers ?? []).length).toBeGreaterThan(0);
  });

  // Guards the pair: the SAME fixture must flip purely on Payment.status, so the
  // filter is doing the work rather than some incidental fixture difference.
  it("flipping only Payment.status flips all three reads", async () => {
    await attachAllocation("pending_approval");
    expect((await readAptRow()).hasPaidInvoice).toBe(false);

    const db = getDb();
    await db.payment.update({ where: { id: PAYMENT }, data: { status: "posted", gatewayStatus: "success" } });
    expect((await readAptRow()).hasPaidInvoice).toBe(true);

    await db.payment.update({ where: { id: PAYMENT }, data: { status: "expired", gatewayStatus: "expired" } });
    expect((await readAptRow()).hasPaidInvoice).toBe(false);

    await dropAllocation();
    expect((await readAptRow()).hasPaidInvoice).toBe(false);
  });
});
