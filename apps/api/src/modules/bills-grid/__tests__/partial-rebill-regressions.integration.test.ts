/**
 * Partial re-Bill — regressions for the adversarial review's executed findings.
 *
 * Every scenario here was DEMONSTRATED to lose or duplicate money before the fixes in
 * 2016794e and 561955ff. The shipped partial-rebill suite passed throughout, which is the
 * point of this file: those tests only ever paid a charge in full, clicked Bill once, and
 * never varied a paid line's amount.
 *
 * Naming maps to the review: F1..F10.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded TEST_DATABASE_URL + ENABLE_* flags.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC, createExpensesService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "aa110000-0000-4000-8000-000000000001";
const USER = "aa110000-0000-4000-8000-000000000002";
const PROP = "aa110000-0000-4000-8000-000000000003";
const APT = "aa110000-0000-4000-8000-000000000004";
const ROOM = "aa110000-0000-4000-8000-000000000005";
const PARTY = "aa110000-0000-4000-8000-000000000006";
const OWNER_PARTY = "aa110000-0000-4000-8000-000000000007";
const TEN = "aa110000-0000-4000-8000-000000000008";

const TZ = "Asia/Kuala_Lumpur";
const PERIOD = currentBillingMonthUTC(TZ);
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

let paySeq = 0;

async function cleanup() {
  const db = getDb();
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
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
  await db.organization.create({ data: { id: ORG, name: "RG", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: TZ, locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "rg@t.test", fullName: "RG", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-RG", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-RG", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-RG", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
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
  return entry.id;
}

async function bill(confirm = true) {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT }, select: { updatedAt: true } });
  const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: e.updatedAt.toISOString(), confirmRebill: confirm }] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("billService failed");
  return r.data.results[0]!;
}

/** Settle a charge the way a POSTED payment does: allocation AND zeroed outstanding. */
async function payCharge(chargeId: string) {
  const db = getDb();
  paySeq += 1;
  const c = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { amount: true, partyId: true } });
  const p = await db.payment.create({
    data: { organizationId: ORG, paymentNumber: `PY-RG-${paySeq}`, partyId: c.partyId, paymentType: "incoming", paymentMethod: "cash", status: "posted", amount: c.amount, currency: "MYR", receivedAt: new Date() },
    select: { id: true },
  });
  await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: p.id, chargeId, allocatedAmount: c.amount, allocatedAt: new Date() } });
  await db.charge.update({ where: { id: chargeId }, data: { outstandingAmount: "0.00", status: "paid" } });
}

const liveWhere = { organizationId: ORG, status: { notIn: ["void", "credited"] } };
const liveCharges = (contains: string) =>
  getDb().charge.findMany({ where: { ...liveWhere, chargeNumber: { contains } }, select: { chargeNumber: true, amount: true, status: true } });

async function bumpWifi(v: string) {
  await getDb().unitBillsGridEntry.updateMany({ where: { organizationId: ORG, apartmentId: APT }, data: { wifi: v } });
}

dn("partial re-Bill regressions (review F1–F10)", () => {
  let entryId = "";
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    entryId = await seed();
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  async function addExpense(amount: string, withSST = false) {
    const r = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN,
      items: [{ description: `Expense ${amount}`, amount, withSST }],
    } as never);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("createExpenses failed");
    return (r.data.ids as string[])[0];
  }

  it("F1: a PAID expense charge is never credited, however many times Bill is clicked", async () => {
    // Was: creditIds unioned the doc-less expense list OUTSIDE the partial-rebill guard, so
    // the paid charge was credited with its live allocation still attached — money
    // received, receivable erased, and a fresh charge asking for it again. Three clicks.
    await addExpense("100.00");
    await bill();
    const exp = await getDb().charge.findFirstOrThrow({ where: { ...liveWhere, chargeNumber: { contains: "GRIDEXP-" } }, select: { id: true } });
    await payCharge(exp.id);

    await bill();
    await bill();

    const after = await getDb().charge.findUniqueOrThrow({ where: { id: exp.id } });
    expect(after.status).not.toBe("credited");
    // …and the tenant is not asked for it a second time.
    expect((await liveCharges("GRIDEXP-")).length).toBe(1);
  });

  it("F2: a kept paid line survives repeated re-Bills without duplicating", async () => {
    // Was: step 9 cancels the proforma carrying the kept paid lines, so they went doc-less
    // and vanished from the split next time — then either P2002 (month permanently
    // un-re-Billable) or a double-bill.
    await bill();
    const elec = await getDb().charge.findFirstOrThrow({ where: { ...liveWhere, chargeNumber: { contains: "-ELECTRICITY" } }, select: { id: true } });
    await payCharge(elec.id);

    await bumpWifi("150.00");
    expect((await bill()).outcome).toBe("reinvoiced");
    await bumpWifi("170.00");
    const second = await bill();
    expect(second.outcome).not.toBe("save_failed");

    // Exactly ONE live electricity charge — the paid original.
    expect((await liveCharges("-ELECTRICITY")).length).toBe(1);
  });

  it("F4: an expense with base PAID and SST unpaid is never re-minted", async () => {
    // Was: the group only counted as paid when BOTH were, so a half-settled line was
    // re-minted beside the still-live paid base — billing the tenant twice for money sent.
    await addExpense("100.00", true);
    await bill();
    const base = await getDb().charge.findFirstOrThrow({
      where: { ...liveWhere, chargeNumber: { contains: "GRIDEXP-" }, NOT: { chargeNumber: { contains: "-SST" } } },
      select: { id: true },
    });
    await payCharge(base.id);

    await bumpWifi("150.00");
    await bill();

    const bases = (await liveCharges("GRIDEXP-")).filter((c) => !c.chargeNumber.includes("-SST"));
    expect(bases.length).toBe(1);
  });

  it("F6: a correction to a PAID line is not silently swallowed", async () => {
    // Was: both sides skipped paid components, so a change confined to one made the
    // multisets identical and returned already_billed — the correction vanished.
    await bill();
    const elec = await getDb().charge.findFirstOrThrow({ where: { ...liveWhere, chargeNumber: { contains: "-ELECTRICITY" } }, select: { id: true } });
    await payCharge(elec.id);

    await getDb().unitBillsGridEntry.updateMany({ where: { organizationId: ORG, apartmentId: APT }, data: { tnbTotalRaw: "400.00" } });
    const r = await bill();
    expect(r.outcome).not.toBe("already_billed");
    expect(r.outcome).toBe("rebill_blocked_payment_exists");
  });

  it("F8: a part-paid month with NOTHING changed is a no-op, not a churn", async () => {
    // Was: recurring/expense previews were not skip-aware, so the multisets could never
    // match and every Bill click cancelled and reissued — which is what made F1 and F2
    // reachable without any edit at all.
    await addExpense("100.00");
    await bill();
    const exp = await getDb().charge.findFirstOrThrow({ where: { ...liveWhere, chargeNumber: { contains: "GRIDEXP-" } }, select: { id: true } });
    await payCharge(exp.id);

    expect((await bill()).outcome).toBe("already_billed");
    expect((await bill()).outcome).toBe("already_billed");
  });

  it("F9: a late expense on a FULLY-paid month still gets billed", async () => {
    // Was: paid_locked returned before the fresh preview, so the line was accepted and
    // then stranded with no route to any document.
    await bill();
    for (const c of await getDb().charge.findMany({ where: liveWhere, select: { id: true } })) {
      await payCharge(c.id);
    }
    await addExpense("250.00");

    const r = await bill();
    expect(r.outcome).not.toBe("paid_locked");
    expect((await liveCharges("GRIDEXP-")).length).toBeGreaterThan(0);
  });

  it("F10: a PARTIALLY-paid charge blocks the re-Bill instead of being called paid", async () => {
    // Was: any cash > 0.005 classified the whole charge paid, so the remainder was never
    // re-billed and the dialog reported the FULL amount as paid.
    await bill();
    const db = getDb();
    const elec = await db.charge.findFirstOrThrow({ where: { ...liveWhere, chargeNumber: { contains: "-ELECTRICITY" } }, select: { id: true, amount: true, partyId: true } });
    const p = await db.payment.create({
      data: { organizationId: ORG, paymentNumber: "PY-RG-PART", partyId: elec.partyId, paymentType: "incoming", paymentMethod: "cash", status: "posted", amount: "100.00", currency: "MYR", receivedAt: new Date() },
      select: { id: true },
    });
    await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: p.id, chargeId: elec.id, allocatedAmount: "100.00", allocatedAt: new Date() } });
    await db.charge.update({ where: { id: elec.id }, data: { outstandingAmount: "200.00", status: "partially_paid" } });

    await bumpWifi("150.00");
    expect((await bill()).outcome).toBe("rebill_blocked_payment_exists");
  });
});
