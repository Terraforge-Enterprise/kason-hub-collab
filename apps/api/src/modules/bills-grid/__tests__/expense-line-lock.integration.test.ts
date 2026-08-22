/**
 * Per-LINE expense lock (spec R6, write half).
 *
 * The reported complaint: a tenant pays ONE line of a month and every other expense line
 * on that month becomes uneditable — `409 ENTRY_LOCKED` on edit, on void, and on adding a
 * new line — even though nobody has paid those.
 *
 * The guard was entry-scoped because it had to be: until partial re-Bill existed, an edit
 * to an unpaid line had no route onto a document (re-Bill refused the whole month), so
 * allowing the edit would have stranded it. With partial re-Bill landed, the guard narrows
 * to the money it is actually protecting.
 *
 * Run: from apps/api, RUN_INTEGRATION=1 + a seeded TEST_DATABASE_URL + ENABLE_* flags.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createExpensesService, updateExpenseService, voidExpenseService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "e2200000-0000-4000-8000-000000000001";
const USER = "e2200000-0000-4000-8000-000000000002";
const PROP = "e2200000-0000-4000-8000-000000000003";
const APT = "e2200000-0000-4000-8000-000000000004";
const ROOM = "e2200000-0000-4000-8000-000000000005";
const PARTY = "e2200000-0000-4000-8000-000000000006";
const TEN = "e2200000-0000-4000-8000-000000000007";
const PAYMENT = "e2200000-0000-4000-8000-000000000008";
const SERIES = "e2200000-0000-4000-8000-000000000009";
const CAT = "e2200000-0000-4000-8000-00000000000a";

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
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
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
  await db.organization.create({ data: { id: ORG, name: "EL", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "el@t.test", fullName: "EL", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-EL", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-EL", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY, tenancyCode: "T-EL", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { id: CAT, organizationId: ORG, code: "other_expense_tenant", name: "Other expense", family: "tenant_income", docType: "invoice", seriesId: SERIES, defaultSstRate: "0", eInvoiceEligible: false, active: true, sortOrder: 1 } });
}

/** Two tenant expense lines on one month. */
async function twoExpenses() {
  const r = await createExpensesService(session, {
    apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN,
    items: [
      { description: "WiFi extra", amount: "100.00", withSST: false },
      { description: "Aircond service", amount: "50.00", withSST: false },
    ],
  } as never);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("createExpenses failed");
  return r.data.ids as string[];
}

/** Mint a charge for one expense and settle it with cash. */
async function payExpense(expenseId: string) {
  const db = getDb();
  const exp = await db.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
  const charge = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `GRIDEXP-202609-${expenseId}`, chargeType: "expense",
      partyId: PARTY, unitId: ROOM, amount: exp.amount, outstandingAmount: "0.00",
      status: "paid", currency: "MYR", dueDate: PERIOD, billingMonth: PERIOD,
      sourceGridEntryId: exp.entryId, sourceGridExpenseId: expenseId, categoryId: CAT,
    },
    select: { id: true, amount: true },
  });
  // entryHasActivePayment only counts charges backed by a LIVE (ISSUED) document, so the
  // flag-off case below is only genuinely exercised once this exists.
  await db.billingDocument.create({
    data: {
      organizationId: ORG, docType: "invoice", documentNumber: `IVTEN-EL-${expenseId.slice(0, 8)}`,
      seriesId: SERIES, issuedById: USER, counterpartyType: "tenant", partyId: PARTY,
      subtotal: charge.amount, sstAmount: "0", total: charge.amount, documentStatus: "ISSUED",
      lines: { create: [{ chargeId: charge.id, categoryId: CAT, description: "paid line", amount: charge.amount, sstRate: "0", sstAmount: "0" }] },
    },
  });
  await db.payment.create({
    data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-EL", partyId: PARTY, paymentType: "incoming", paymentMethod: "cash", status: "posted", amount: charge.amount, currency: "MYR", receivedAt: new Date() },
  });
  await db.paymentAllocation.create({
    data: { organizationId: ORG, paymentId: PAYMENT, chargeId: charge.id, allocatedAmount: charge.amount, allocatedAt: new Date() },
  });
}

dn("per-line expense lock (R6 write half)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    await seed();
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("paying ONE line leaves the OTHER line editable", async () => {
    // The reported complaint, directly.
    const [paidId, otherId] = await twoExpenses();
    await payExpense(paidId);

    const r = await updateExpenseService(session, otherId, { description: "Aircond service v2" });
    expect(r.ok).toBe(true);
  });

  it("the PAID line itself is still refused", async () => {
    const [paidId] = await twoExpenses();
    await payExpense(paidId);

    const r = await updateExpenseService(session, paidId, { description: "should not change" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toBe("ENTRY_LOCKED");
  });

  it("allows internal actual-cost bookkeeping after the customer charge is paid", async () => {
    const [paidId] = await twoExpenses();
    await payExpense(paidId);

    const r = await updateExpenseService(session, paidId, {
      actualCost: "80.00",
      costVendor: "Sofa supplier",
      costPaymentStatus: "paid",
      costPaymentDate: "2026-08-20",
      costPaymentAccount: "Maybank",
    });
    expect(r.ok).toBe(true);

    const saved = await getDb().gridExpense.findUniqueOrThrow({ where: { id: paidId } });
    expect(saved.actualCost?.toFixed(2)).toBe("80.00");
    expect(saved.costVendor).toBe("Sofa supplier");
    expect(saved.costPaymentStatus).toBe("paid");
  });

  it("does not allow a cost patch to smuggle a paid customer amount edit", async () => {
    const [paidId] = await twoExpenses();
    await payExpense(paidId);

    const r = await updateExpenseService(session, paidId, {
      amount: "999.00",
      actualCost: "80.00",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ENTRY_LOCKED");
  });

  it("the paid line cannot be voided, the unpaid one can", async () => {
    const [paidId, otherId] = await twoExpenses();
    await payExpense(paidId);

    const refused = await voidExpenseService(session, paidId);
    expect(refused.ok).toBe(false);

    const allowed = await voidExpenseService(session, otherId);
    expect(allowed.ok).toBe(true);
  });

  it("a NEW line can be added to a part-paid month", async () => {
    // Adding was refused too, which is what left a late expense with nowhere to go.
    const [paidId] = await twoExpenses();
    await payExpense(paidId);

    const r = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN,
      items: [{ description: "Late expense", amount: "300.00", withSST: false }],
    } as never);
    expect(r.ok).toBe(true);
  });

  it("flag OFF ⇒ the old entry-wide refusal, unchanged", async () => {
    // Without partial re-Bill an edit to an unpaid line has no route onto a document, so
    // permitting it would strand the edit. The broad guard is correct in that world.
    delete process.env.ENABLE_PROFORMA_INVOICES;
    const [paidId, otherId] = await twoExpenses();
    await payExpense(paidId);

    const r = await updateExpenseService(session, otherId, { description: "nope" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ENTRY_LOCKED");
  });
});
