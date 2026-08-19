/**
 * Partial re-Bill after payment (spec R4) — THE money gate of the proforma feature.
 *
 * Before this, any money against a unit-month froze the whole month:
 * `rebill_blocked_payment_exists`, no workaround. Now the paid lines are kept exactly as
 * they are — their charge stays live and uncredited — and only the unpaid lines are
 * credited and re-minted onto a fresh proforma.
 *
 * Both failure directions are money bugs, so both are pinned here:
 *   - a charge wrongly called PAID is silently dropped from the new proforma and never billed
 *   - a charge wrongly called UNPAID is credited while a live allocation still points at it,
 *     erasing a receivable for money that was actually received
 *
 * PERIOD IS THE CURRENT BILLING MONTH ON PURPOSE. Re-Bill rule 1 refuses any earlier period
 * with `rebill_blocked_previous_period`, which would make this suite pass for the wrong
 * reason without ever reaching the payment split.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded TEST_DATABASE_URL + ENABLE_* flags.
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

const ORG = "c9910000-0000-4000-8000-000000000001";
const USER = "c9910000-0000-4000-8000-000000000002";
const PROP = "c9910000-0000-4000-8000-000000000003";
const APT = "c9910000-0000-4000-8000-000000000004";
const ROOM = "c9910000-0000-4000-8000-000000000005";
const PARTY = "c9910000-0000-4000-8000-000000000006";
const OWNER_PARTY = "c9910000-0000-4000-8000-000000000007";
const TEN = "c9910000-0000-4000-8000-000000000008";
const PAYMENT = "c9910000-0000-4000-8000-000000000009";

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
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  const { ensureChargeCategorySeeds } = await import("../../charge-categories/seed");
  await db.organization.create({ data: { id: ORG, name: "PR", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: TZ, locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "pr@t.test", fullName: "PR", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-PR", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-PR", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-PR", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await ensureChargeCategorySeeds(ORG);

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "60.00",
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "tenant", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: TEN, partyId: PARTY, amount: "0.00", createdBy: USER } });
  return entry.updatedAt.toISOString();
}

async function bill(token: string, confirm = false) {
  const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: token, confirmRebill: confirm }] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("billService failed");
  return r.data.results[0]!;
}

async function freshToken() {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT }, select: { updatedAt: true } });
  return e.updatedAt.toISOString();
}

/** Attach a cash-backed allocation to the tenant's ELECTRICITY charge. */
async function payElectricity(status = "posted") {
  const db = getDb();
  const charge = await db.charge.findFirstOrThrow({
    where: { organizationId: ORG, chargeNumber: { contains: "-ELECTRICITY" }, status: "posted" },
    select: { id: true, amount: true, partyId: true },
  });
  await db.payment.create({
    data: {
      id: PAYMENT, organizationId: ORG, paymentNumber: `PY-PR-${status}`, partyId: charge.partyId,
      paymentType: "incoming", paymentMethod: "cash", status,
      amount: charge.amount, currency: "MYR", receivedAt: new Date(),
    },
  });
  await db.paymentAllocation.create({
    data: { organizationId: ORG, paymentId: PAYMENT, chargeId: charge.id, allocatedAmount: charge.amount, allocatedAt: new Date() },
  });
  // A POSTED payment SETTLES the charge — applyAllocationToChargeTx zeroes outstanding and
  // flips the status. Creating the allocation alone mimics the phantom-FPX shape (correct
  // for pending_approval, where the charge is deliberately untouched) and would leave a
  // fully-paid line looking PARTIALLY paid, which the re-Bill now correctly refuses.
  if (status === "posted") {
    await db.charge.update({ where: { id: charge.id }, data: { outstandingAmount: "0.00", status: "paid" } });
  }
  return charge.id;
}

/** Change something so the re-Bill is not a no-op. */
async function bumpWifi(amount: string) {
  const db = getDb();
  await db.unitBillsGridEntry.updateMany({ where: { organizationId: ORG, apartmentId: APT }, data: { wifi: amount } });
}

dn("partial re-Bill after payment (R4)", () => {
  let token = "";

  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    token = await seed();
    expect((await bill(token)).outcome).toBe("invoiced");
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("keeps the paid line, replaces the rest", async () => {
    const db = getDb();
    const paidChargeId = await payElectricity();
    await bumpWifi("150.00");

    const r = await bill(await freshToken(), true);
    expect(r.outcome).toBe("reinvoiced");

    // THE money assertion: the paid charge was never written to.
    const paidAfter = await db.charge.findUniqueOrThrow({ where: { id: paidChargeId } });
    // The point is that it was NOT credited — crediting would erase a receivable a live
    // allocation still points at. It stays settled, exactly as the payment left it.
    expect(paidAfter.status).toBe("paid");
    expect(paidAfter.status).not.toBe("credited");

    // The fresh proforma carries no electricity line — the tenant is not asked twice.
    const fresh = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "proforma", documentStatus: "ISSUED" },
      include: { lines: true },
    });
    const freshCharges = await db.charge.findMany({
      where: { id: { in: fresh.lines.map((l) => l.chargeId).filter((x): x is string => !!x) } },
      select: { chargeNumber: true },
    });
    expect(freshCharges.some((c) => c.chargeNumber.includes("ELECTRICITY"))).toBe(false);
    expect(freshCharges.some((c) => c.chargeNumber.includes("WIFI"))).toBe(true);

    // R4: no credit note is issued for a re-bill.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "credit_note" } })).toBe(0);
  });

  it("every line paid ⇒ paid_locked, and nothing is written", async () => {
    const db = getDb();
    // Pay EVERY live tenant + owner charge.
    const charges = await db.charge.findMany({ where: { organizationId: ORG, status: "posted" }, select: { id: true, amount: true, partyId: true } });
    await db.payment.create({
      data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-PR-ALL", partyId: charges[0].partyId, paymentType: "incoming", paymentMethod: "cash", status: "posted", amount: "9999.00", currency: "MYR", receivedAt: new Date() },
    });
    for (const c of charges) {
      await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: c.id, allocatedAmount: c.amount, allocatedAt: new Date() } });
      // Settle it too — a posted payment zeroes outstanding. Without this every line reads
      // PARTIALLY paid and the re-Bill correctly refuses instead of reporting paid_locked.
      await db.charge.update({ where: { id: c.id }, data: { outstandingAmount: "0.00", status: "paid" } });
    }
    // Deliberately change NOTHING. Bumping a value here would change a line the tenant has
    // already PAID, which is a correction routed to accounting — not a re-Bill — and would
    // now (correctly) return rebill_blocked_payment_exists instead.
    const before = await db.charge.count({ where: { organizationId: ORG, status: "credited" } });
    expect((await bill(await freshToken(), true)).outcome).toBe("paid_locked");
    expect(await db.charge.count({ where: { organizationId: ORG, status: "credited" } })).toBe(before);
  });

  it("flag OFF ⇒ the old hard block, byte-identical", async () => {
    delete process.env.ENABLE_PROFORMA_INVOICES;
    await payElectricity();
    await bumpWifi("150.00");
    expect((await bill(await freshToken(), true)).outcome).toBe("rebill_blocked_payment_exists");
  });

  it("an abandoned FPX allocation is NOT treated as paid", async () => {
    // The other failure direction. `pending_approval` means the tenant opened the bank
    // page and walked away — no money arrived, so the charge must be re-billed normally.
    // Dropping it from the new proforma would leave it never billed to anyone.
    const db = getDb();
    const chargeId = await payElectricity("pending_approval");
    await bumpWifi("150.00");

    expect((await bill(await freshToken(), true)).outcome).toBe("reinvoiced");

    // It was credited like any other unpaid line, and re-minted.
    const old = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(old.status).toBe("credited");
    const fresh = await db.charge.findMany({ where: { organizationId: ORG, status: "posted", chargeNumber: { contains: "-ELECTRICITY" } } });
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("a FULLY REVERSED payment reads unpaid", async () => {
    const db = getDb();
    const chargeId = await payElectricity();
    const alloc = await db.paymentAllocation.findFirstOrThrow({ where: { organizationId: ORG, chargeId } });
    await db.paymentAllocationReversal.create({
      data: {
        organizationId: ORG, originalAllocationId: alloc.id, amount: alloc.allocatedAmount,
        reason: "test reversal", reversedById: USER, idempotencyKey: `rev-${alloc.id}`,
      },
    });
    await bumpWifi("150.00");

    expect((await bill(await freshToken(), true)).outcome).toBe("reinvoiced");
    const old = await db.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(old.status).toBe("credited"); // treated as unpaid, credited normally
  });
  it("the confirmation gate names the lines it will KEEP (R7)", async () => {
    // Before this the dialog showed only the invoice numbers, which after partial re-bill
    // reads as "everything here is being voided" — the opposite of what happens to a paid
    // line. Nothing is mutated by an unconfirmed Bill.
    const db = getDb();
    await payElectricity();
    await bumpWifi("150.00");

    const before = await db.charge.count({ where: { organizationId: ORG, status: "credited" } });
    const r = await bill(await freshToken(), false);
    expect(r.outcome).toBe("rebill_confirmation_required");
    expect(r.keptPaidLines?.length).toBe(1);
    expect(r.keptPaidLines![0].description.toLowerCase()).toContain("electricity");
    // Nothing written by the unconfirmed call.
    expect(await db.charge.count({ where: { organizationId: ORG, status: "credited" } })).toBe(before);
  });

  it("keptPaidLines is absent when nothing is paid", async () => {
    await bumpWifi("150.00");
    const r = await bill(await freshToken(), false);
    expect(r.outcome).toBe("rebill_confirmation_required");
    expect(r.keptPaidLines).toBeUndefined();
  });
});
