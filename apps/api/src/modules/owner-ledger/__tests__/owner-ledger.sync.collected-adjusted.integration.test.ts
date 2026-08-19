/**
 * Owner-ledger collected figures must be CN/DN-adjusted (fix 2026-08-07).
 *
 * Reproduces the reported statement: a WHOLE unit whose tenant's Electricity
 * charge (RM 400) carried a RM 30 credit note and whose recurring carve-out
 * (RM 150) carried a RM 30 debit note — both fully settled by the tenant at the
 * adjusted amounts (370 / 180 — actual cash 550). The ledger booked collected as
 * raw `amount − outstanding`, which misread the notes as cash:
 *
 *   §4 showed Electricity RM 400 (the credited RM 30 counted as collected),
 *   Recurring RM 150 (the extra RM 30 genuinely collected was invisible), and
 *   the pass-through total footed to 550 while its own rows summed 550 ± wrong —
 *   688 vs 683 on the full reported statement. Worse: a CN on an UNPAID rent
 *   charge produced phantom collected (2300 − 2000 = "300 collected", zero cash).
 *
 * The fix nets active notes into the collected basis (netAdjustmentsByChargeId —
 * the same seam-#1 netting Source-2 statement expenses already had) and makes
 * §4's display fields agree: chargedAmount = billed AFTER notes, detail names
 * the note. Charges with no notes stay byte-identical (map absent = 0).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0e..d*).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { summarizeOwnerPeriod } from "@kason/shared";
import type { OwnerLedgerLine } from "@kason/shared";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import { assembleYannieStatementForMonth } from "../../owner-billing/owner-statement-sections";
import { getLiveStatementSectionsService } from "../../owner-billing/owner-billing.service";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0e000000-0000-4000-8000-0000000000d1";
const USER = "0e000000-0000-4000-8000-0000000000d2";
const OWNER = "0e000000-0000-4000-8000-0000000000d3";
const TENANT = "0e000000-0000-4000-8000-0000000000d4";
const PROPERTY = "0e000000-0000-4000-8000-0000000000d5";
const APARTMENT = "0e000000-0000-4000-8000-0000000000d6";
const UNIT = "0e000000-0000-4000-8000-0000000000d7";
const TENANCY = "0e000000-0000-4000-8000-0000000000d8";
const SERIES = "0e000000-0000-4000-8000-0000000000d9";
const CH_ELEC = "0e000000-0000-4000-8000-0000000000da";
const CH_RECUR = "0e000000-0000-4000-8000-0000000000db";
const CH_RENT = "0e000000-0000-4000-8000-0000000000dc";
const CN_ELEC = "0e000000-0000-4000-8000-0000000000dd";
const DN_RECUR = "0e000000-0000-4000-8000-0000000000de";
const CN_RENT = "0e000000-0000-4000-8000-0000000000df";
const GRID_ENTRY = "0e000000-0000-4000-8000-0000000000e0";
const GX_1 = "0e000000-0000-4000-8000-0000000000e1";
const GX_2 = "0e000000-0000-4000-8000-0000000000e2";
const GX_OWN = "0e000000-0000-4000-8000-0000000000e3";
/** The tenant invoice the three notes below adjust — every real note carries an
 *  originalDocumentId (see seedNote), and the netting helpers now REQUIRE it. */
const ORIG_DOC = "0e000000-0000-4000-8000-0000000000e4";
/** A PRIMARY rent bill whose docType is `debit_note` — the pay_back_landlord shape. */
const RENT_BILL = "0e000000-0000-4000-8000-0000000000e5";
/** The REPORTED case: a mid-month tenancy, rent prorated to RM 2.42 and PAID in
 *  full, billed on its own primary `debit_note`. Kept out of `seed()` so the
 *  fixture's other assertions stay exactly as they were. */
const CH_RENT_PRO = "0e000000-0000-4000-8000-0000000000e6";
const BILL_RENT_PRO = "0e000000-0000-4000-8000-0000000000e7";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest",
};
const bctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.gridExpense.deleteMany({ where: org });
  await db.unitBillsGridEntry.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
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

/**
 * One adjustment note (documentStatus defaults to ISSUED — the active state).
 *
 * `originalDocumentId` is NOT optional dressing: it is the field that makes this a
 * CORRECTION rather than a bill in its own right, every mint path sets it
 * (charge-adjustment.service.ts:225/340, credit-notes.service.ts:185/498, …), and
 * both netting helpers now require it — because a `pay_back_landlord` charge's
 * PRIMARY bill is itself a `debit_note` and was being netted against itself. A
 * fixture that omitted it was describing a document production cannot produce.
 */
async function seedNote(
  id: string,
  docType: "credit_note" | "debit_note",
  documentNumber: string,
  chargeId: string,
  amount: string,
) {
  const db = getDb();
  await db.billingDocument.create({
    data: {
      id, organizationId: ORG, docType, documentNumber, seriesId: SERIES,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      originalDocumentId: ORIG_DOC,
      subtotal: amount, sstAmount: 0, total: amount,
      lines: { create: [{ chargeId, description: "Adjustment", amount, sstRate: 0, sstAmount: 0 }] },
    },
  });
}

/** The primary bill the notes adjust. Plain `invoice`, originalDocumentId null. */
async function seedOriginalInvoice() {
  await getDb().billingDocument.create({
    data: {
      id: ORIG_DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-ADJ-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, subtotal: "2850.00", sstAmount: 0, total: "2850.00",
    },
  });
}

/**
 * A PRIMARY tenant bill that is itself `docType: "debit_note"` — NOT an
 * adjustment. This is what issue.service.ts's legacy path mints for any
 * pay_back_landlord category (`docType: category.docType`), and `rental` is
 * seeded exactly that way (seed-categories.ts). `originalDocumentId` stays
 * null: it adjusts nothing, it IS the bill. Its line carries the chargeId it
 * bills, which is precisely how it used to get mistaken for a debit note
 * against its own charge.
 */
async function seedPrimaryDebitNoteBill(
  id: string,
  documentNumber: string,
  chargeId: string,
  amount: string,
) {
  await getDb().billingDocument.create({
    data: {
      id, organizationId: ORG, docType: "debit_note", documentNumber, seriesId: SERIES,
      status: "issued", issuedById: USER, counterpartyType: "tenant", partyId: TENANT,
      originalDocumentId: null,
      subtotal: amount, sstAmount: 0, total: amount,
      lines: { create: [{ chargeId, description: "Monthly rental", amount, sstRate: 0, sstAmount: 0 }] },
    },
  });
}

/**
 * The reported month:
 *   • Electricity 400, PAID at the adjusted 370 (outstanding 0), active CN 30
 *   • Recurring  150, PAID at the adjusted 180 (outstanding 0), active DN 30
 *   • Rent      2300, UNPAID, active CN 300 → outstanding 2000 (the adjustment
 *     service's write) — collected must be 0.00, never a phantom 300
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "OL ADJ Org", slug: "ol-adj-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "ol-adj@example.com", fullName: "OL ADJ Operator", status: "active", role: "admin", userType: "operator" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "OL ADJ Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "OL ADJ Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROPERTY, organizationId: ORG, name: "OL ADJ Property", propertyCode: "OL-ADJ-P1", propertyType: "apartment", addressLine1: "1 ADJ St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "OL-ADJ-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "2300" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });

  const base = { organizationId: ORG, tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, currency: "MYR" };
  await db.charge.create({
    data: { ...base, id: CH_ELEC, chargeNumber: "OL-ADJ-ELEC", chargeType: "utility", status: "paid", dueDate: new Date(Date.UTC(2026, 6, 10)), amount: "400.00", outstandingAmount: "0.00", description: "Electricity (TNB) 202607" },
  });
  await db.charge.create({
    data: { ...base, id: CH_RECUR, chargeNumber: "OL-ADJ-RECUR", chargeType: "utility", status: "paid", dueDate: new Date(Date.UTC(2026, 6, 10)), amount: "150.00", outstandingAmount: "0.00", description: "Recurring fees 202607" },
  });
  await db.charge.create({
    data: { ...base, id: CH_RENT, chargeNumber: "OL-ADJ-RENT", chargeType: "rent", status: "posted", dueDate: new Date(Date.UTC(2026, 6, 5)), amount: "2300.00", outstandingAmount: "2000.00", description: "Rent 202607" },
  });

  await seedOriginalInvoice();
  await seedNote(CN_ELEC, "credit_note", "CN-ADJ-1", CH_ELEC, "30.00");
  await seedNote(DN_RECUR, "debit_note", "DN-ADJ-1", CH_RECUR, "30.00");
  await seedNote(CN_RENT, "credit_note", "CN-ADJ-2", CH_RENT, "300.00");

  // ⚠️ REGRESSION GUARD. The rent charge's OWN primary bill, in the shape
  // seed-categories.ts gives every `pay_back_landlord` charge: docType
  // `debit_note`, originalDocumentId NULL. It is a bill, not a correction, and
  // must contribute NOTHING to the netting — otherwise the rent is a +100%
  // adjustment against itself and `collectedString` books the whole unpaid rent
  // as collected cash.
  await db.billingDocument.create({
    data: {
      id: RENT_BILL, organizationId: ORG, docType: "debit_note", documentNumber: "RB-ADJ-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, subtotal: "2300.00", sstAmount: 0, total: "2300.00",
      lines: { create: [{ chargeId: CH_RENT, description: "Rent 202607", amount: "2300.00", sstRate: 0, sstAmount: 0 }] },
    },
  });

  // Tenant-paid grid expenses (GRIDEXP mirror: chargeType "expense",
  // sourceGridExpenseId → a REAL GridExpense row, billingMonth stamped) — the
  // user's two RM 300 fees. Plus the OWNER-borne twin, which must NOT surface
  // as a tenant-paid row (it is a real Source-6 payout deduction, not tenant
  // money).
  await db.unitBillsGridEntry.create({
    data: { id: GRID_ENTRY, organizationId: ORG, apartmentId: APARTMENT, periodMonth: MONTH_START, createdBy: USER },
  });
  const gxBase = { organizationId: ORG, entryId: GRID_ENTRY, apartmentId: APARTMENT, periodMonth: MONTH_START, withSST: false, createdBy: USER };
  await db.gridExpense.create({ data: { ...gxBase, id: GX_1, bearer: "tenant", description: "TEST NO STT", amount: "300.00", partyId: TENANT, tenancyId: TENANCY } });
  await db.gridExpense.create({ data: { ...gxBase, id: GX_2, bearer: "tenant", description: "TEST SST", amount: "300.00", partyId: TENANT, tenancyId: TENANCY } });
  await db.gridExpense.create({ data: { ...gxBase, id: GX_OWN, bearer: "owner", description: "OWNER EXPENSE", amount: "150.00" } });

  const expBase = { organizationId: ORG, tenancyId: TENANCY, unitId: UNIT, currency: "MYR", chargeType: "expense", billingMonth: MONTH_START, dueDate: new Date(Date.UTC(2026, 6, 1)) };
  await db.charge.create({
    data: { ...expBase, partyId: TENANT, chargeNumber: "OL-ADJ-EXP-1", status: "paid", amount: "300.00", outstandingAmount: "0.00", description: "TEST NO STT", sourceGridExpenseId: GX_1 },
  });
  await db.charge.create({
    data: { ...expBase, partyId: TENANT, chargeNumber: "OL-ADJ-EXP-2", status: "paid", amount: "300.00", outstandingAmount: "0.00", description: "TEST SST", sourceGridExpenseId: GX_2 },
  });
  await db.charge.create({
    data: { ...expBase, partyId: OWNER, chargeNumber: "OL-ADJ-EXP-OWN", status: "posted", amount: "150.00", outstandingAmount: "150.00", description: "OWNER EXPENSE", sourceGridExpenseId: GX_OWN },
  });
}

const toLines = (rows: Array<{ direction: string; category: string; amount: { toString(): string }; sstAmount: { toString(): string } | null; includeInPayout: boolean; taxCategory: string }>): OwnerLedgerLine[] =>
  rows.map((e) => ({
    direction: e.direction as "income" | "expense" | "payout",
    category: e.category,
    amount: e.amount.toString(),
    sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
    includeInPayout: e.includeInPayout,
    taxCategory: e.taxCategory,
  }));

dn("owner-ledger sync — collected figures net active CN/DN", () => {
  beforeEach(async () => { await cleanup(); await seed(); });
  afterAll(async () => { await cleanup(); });

  it("books adjusted collected per source charge, and §4 displays agree", async () => {
    const db = getDb();
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });
    const byCharge = new Map(rows.map((r) => [r.sourceChargeId, r]));

    // CN on a PAID charge: the credited 30 is NOT cash — collected is 370, not 400.
    expect(byCharge.get(CH_ELEC)?.amount.toString()).toBe("370");
    // DN on a PAID charge: the extra 30 genuinely collected — 180, not 150 (raw basis
    // even went NEGATIVE while this charge sat unpaid).
    expect(byCharge.get(CH_RECUR)?.amount.toString()).toBe("180");
    // CN on an UNPAID charge: zero cash in — never the phantom 300 the raw basis booked.
    expect(byCharge.get(CH_RENT)?.amount.toString()).toBe("0");

    // Pass-through total = what the tenant ACTUALLY paid through KAEN: 370 + 180.
    const s = summarizeOwnerPeriod(toLines(rows));
    expect(s.passThroughIncome).toBe("550.00");
    expect(s.grossRental, "unpaid rent contributes nothing").toBe("0.00");

    // §4 display basis (live view): the primary cell (billed) shows the ADJUSTED
    // billed figure and the row's detail NAMES the note — the "credit note not
    // showing" half of the report.
    const sections = await assembleYannieStatementForMonth(bctx, OWNER, MONTH_START, null);
    const elecRow = sections.incomeBreakdown.rows.find((r) => r.detail?.startsWith("Electricity"));
    expect(elecRow?.chargedAmount).toBe("370.00");
    expect(elecRow?.amount).toBe("370.00");
    expect(elecRow?.detail).toContain("Credit note -RM 30.00");
    const recurRow = sections.incomeBreakdown.rows.find((r) => r.detail?.startsWith("Recurring"));
    expect(recurRow?.chargedAmount).toBe("180.00");
    expect(recurRow?.detail).toContain("Debit note +RM 30.00");
    expect(sections.incomeBreakdown.passThroughIncome).toBe("550.00");
  });

  it("§4 lists tenant-paid grid expenses as informational rows — visible, never summed", async () => {
    await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    const sections = await assembleYannieStatementForMonth(bctx, OWNER, MONTH_START, null);

    const tenantPaid = sections.incomeBreakdown.rows.filter((r) => r.incomeType === "Tenant-paid Expense");
    expect(tenantPaid.map((r) => r.detail)).toEqual(["TEST NO STT", "TEST SST"]);
    expect(tenantPaid.every((r) => r.isInformational)).toBe(true);
    expect(tenantPaid.every((r) => r.amount === "300.00" && r.chargedAmount === "300.00")).toBe(true);
    expect(tenantPaid.every((r) => r.mgmtFee === "0.00")).toBe(true);
    expect(tenantPaid.every((r) => r.paymentStatus === "paid")).toBe(true);

    // The OWNER-borne twin is a real Source-6 deduction — never a tenant-paid row.
    expect(sections.incomeBreakdown.rows.some((r) => r.detail === "OWNER EXPENSE")).toBe(false);

    // Informational rows perturb NO total: pass-through stays exactly the
    // utilities figure and totalIncome stays untouched.
    expect(sections.incomeBreakdown.passThroughIncome).toBe("550.00");
    expect(sections.incomeBreakdown.totalIncome).toBe("0.00");
  });

  it("the LIVE statement service read-through-syncs — totals agree with rows without a manual sync", async () => {
    // NO explicit syncMonthService call: the ledger is empty when the live view is
    // requested. Pre-fix the service assembled stale/absent rows (the reported
    // "rows say 683, total says 688" split); now it materialises the month first.
    const res = await getLiveStatementSectionsService(bctx, OWNER, MONTH, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.incomeBreakdown.passThroughIncome).toBe("550.00");
    const elecRow = res.data.incomeBreakdown.rows.find((r) => r.detail?.startsWith("Electricity"));
    expect(elecRow?.amount).toBe("370.00");
  });

  it("charges without notes stay byte-identical to the raw basis", async () => {
    const db = getDb();
    // Retire all three notes → every net is 0 → raw basis applies everywhere.
    await db.billingDocument.updateMany({
      where: { organizationId: ORG },
      data: { documentStatus: "CANCELLED" },
    });
    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });
    const byCharge = new Map(rows.map((r) => [r.sourceChargeId, r]));
    expect(byCharge.get(CH_ELEC)?.amount.toString()).toBe("400");
    expect(byCharge.get(CH_RECUR)?.amount.toString()).toBe("150");
    // amount 2300 − outstanding 2000 = 300 on the raw basis (the outstanding write
    // stays where the adjustment service left it — display reads never undo it).
    expect(byCharge.get(CH_RENT)?.amount.toString()).toBe("300");
  });

  it("a PRIMARY debit_note bill is NOT an adjustment against its own charge", async () => {
    // The reported statement: a tenancy starting mid-month, rent RM 5.00
    // prorated to RM 2.42 (15/31 days), billed on its OWN primary document —
    // which for the `rental` category is minted `docType: "debit_note"`.
    // Tenant paid the RM 2.42 in full.
    //
    // The fixture's other rent case (CH_RENT) is UNPAID, so it can only ever
    // prove "collected stays 0.00". This one is PAID, which is what makes it
    // able to catch the doubling the user actually reported.
    const db = getDb();
    await db.charge.create({
      data: {
        organizationId: ORG, tenancyId: TENANCY, unitId: UNIT, partyId: TENANT, currency: "MYR",
        id: CH_RENT_PRO, chargeNumber: "OL-ADJ-RENT-PRO", chargeType: "rent", status: "paid",
        dueDate: new Date(Date.UTC(2026, 6, 5)), amount: "2.42", outstandingAmount: "0.00",
        description: "Rent 202607 (prorated)",
      },
    });
    // "RB-ADJ-2": the fixture's own primary rent bill already owns "RB-ADJ-1",
    // and BillingDocument is unique on [organizationId, documentNumber].
    await seedPrimaryDebitNoteBill(BILL_RENT_PRO, "RB-ADJ-2", CH_RENT_PRO, "2.42");

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);

    const rows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, status: "active" } });
    const rentRow = rows.find((r) => r.sourceChargeId === CH_RENT_PRO);
    // Pre-fix this booked 4.84 — the bill netted as a +2.42 debit note against
    // the charge it bills, crediting the owner DOUBLE the cash that arrived.
    expect(rentRow?.amount.toString()).toBe("2.42");

    // §4 must agree, and must NOT invent a "Debit note +RM 2.42" that no human
    // ever raised: the only document here is the rent bill itself.
    const sections = await assembleYannieStatementForMonth(bctx, OWNER, MONTH_START, null);
    const proRow = sections.incomeBreakdown.rows.find((r) => r.detail?.startsWith("Rent 202607 (prorated)"));
    expect(proRow?.amount).toBe("2.42");
    expect(proRow?.chargedAmount).toBe("2.42");
    expect(proRow?.detail).not.toContain("Debit note");
    // …and the per-line management fee follows the un-doubled base.
    expect(proRow?.mgmtFee).toBe("0.00"); // no ManagementFeeConfig in this fixture
  });
});
