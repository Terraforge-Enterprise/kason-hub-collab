/**
 * Task 6 — Receipt PDF builder tests.
 *
 * Two test suites:
 *
 * 1. INTEGRATION (RUN_INTEGRATION=1) — buildOwnerLedgerReceiptModel real DB:
 *    Seeds active ledger rows (income + expense, two apartments) + a fee config + deposit.
 *    (a) empty scope (apartment with no rows) → null
 *    (b) expense-only filter: lineItems contains ONLY non-mgmt-fee expense rows; footing holds
 *    (c) apartmentId scope → only that apartment's expense rows + scopeLabel = unitCode
 *    (d) buildOwnerLedgerReceiptPdf: non-empty → Uint8Array starting with "%PDF-"
 *    (e) model shape: header.receiptNo matches IVOWN-<YYYYMM>-<scope> (fallback prefix — this
 *        suite's org has no seeded DocumentSeries row); date is YYYY-MM-DD format
 *
 * 2. UNIT (always runs) — buildOwnerLedgerReceiptPdf null-vs-bytes contract:
 *    Mocks htmlToPdf + findOwnerLedgerRowsForMonth (no DB, no Chromium).
 *    - empty rows → null
 *    - non-empty rows (expense only) → Uint8Array whose first 5 bytes = "%PDF-"
 *
 * 3. UNIT — renderOwnerLedgerReceiptHtml (always runs, no DB):
 *    Clean invoice columns; no ledger-dump columns; correct title; footer present.
 *
 * Disjoint fixed UUIDs (a6 prefix, unused by any other suite).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

// ── Module mocks — declared BEFORE any service import ────────────────────────

// 0. Storage: mocked so proof-pack (called by buildReceiptWithBillsPdf) never
//    hits a real Supabase bucket. Integration tests override fetchStorageBuffer
//    via mockImplementation to supply real bill bytes.
vi.mock("../../../lib/storage", () => ({
  fetchStorageBuffer: vi.fn(async () => null),
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

// 1. htmlToPdf: no Chromium needed. Returns fake PDF bytes.
vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

// 2. findOwnerLedgerRowsForMonth: allows unit suite to control returned rows.
//    We mock ONLY this named export; all other exports from owner-statement-sections
//    are passed through untouched via importOriginal.
//    IMPORTANT: we use vi.fn() with NO wrapper — wrapping the actual function would
//    cause infinite recursion if the real function is later restored via mockImplementation.
vi.mock("../../owner-billing/owner-statement-sections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../owner-billing/owner-statement-sections")>();
  return {
    ...actual,
    findOwnerLedgerRowsForMonth: vi.fn(),
  };
});

// 3. resolveOwnerPayoutForScope is NO LONGER used by the receipt service.
//    Mock it here only to ensure that if it IS accidentally called, the test fails explicitly
//    (returning undefined). The receipt is now expenses-only; payout scope is not involved.
vi.mock("../owner-payout-scope.service", () => ({
  resolveOwnerPayoutForScope: vi.fn(),
}));

// 4. getTemplateForOrgDocType: stub for the unit suite — returns a minimal template
//    with orgName + orgRegNo so the letterhead test can assert without hitting the DB.
//    The integration suite restores the real implementation in beforeEach.
vi.mock("../../../lib/document-templates/service", () => ({
  getTemplateForOrgDocType: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  buildOwnerLedgerReceiptModel,
  buildOwnerLedgerReceiptPdf,
  buildReceiptWithBillsPdf,
  renderOwnerLedgerReceiptHtml,
} from "../owner-ledger-receipt.service";
import { findOwnerLedgerRowsForMonth, computeOwnerPayout } from "../../owner-billing/owner-statement-sections";
import { resolveOwnerPayoutForScope } from "../owner-payout-scope.service";
import { getTemplateForOrgDocType } from "../../../lib/document-templates/service";
import { fetchStorageBuffer } from "../../../lib/storage";
import { htmlToPdf } from "../../../lib/document-templates/pdf";
import { centsToString } from "@kason/shared";

// ─── Integration suite constants ───────────────────────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (a6 prefix — task-6-receipt, unused by any other suite)
const ORG       = "a6000000-0000-4000-8000-000000000001";
const USER      = "a6000000-0000-4000-8000-000000000002";
const PARTY     = "a6000000-0000-4000-8000-000000000003";
const OWNER     = "a6000000-0000-4000-8000-000000000004";
const PROP      = "a6000000-0000-4000-8000-000000000005";
const APT_1     = "a6000000-0000-4000-8000-000000000011";
const APT_2     = "a6000000-0000-4000-8000-000000000012";
const APT_EMPTY = "a6000000-0000-4000-8000-000000000013";

const MONTH = "2026-07";
const MONTH_START = new Date(Date.UTC(2026, 6, 1));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ─── Integration helpers ────────────────────────────────────────────────────────

const TENANT      = "a6000000-0000-4000-8000-000000000031";
const LISTING_21  = "a6000000-0000-4000-8000-000000000021";
const LISTING_22  = "a6000000-0000-4000-8000-000000000022";
const TENANCY_21  = "a6000000-0000-4000-8000-000000000041";

async function cleanup() {
  // Import getDb from the REAL @kason/db (not the unit-test mock alias).
  // When RUN_INTEGRATION=1, vitest resolves @kason/db to the real package.
  const { getDb } = await import("@kason/db");
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const { getDb } = await import("@kason/db");
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "T6R Org", slug: "t6r-receipt-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "T6R Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "t6r-op@example.com", fullName: "T6R Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "T6R Owner Dato Razak", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "T6R Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "T6R Property", propertyCode: "T6RP", propertyType: "apartment", addressLine1: "1 T6R St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT_1, organizationId: ORG, propertyId: PROP, unitCode: "A-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_2, organizationId: ORG, propertyId: PROP, unitCode: "A-02", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_EMPTY, organizationId: ORG, propertyId: PROP, unitCode: "A-03", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING_21, organizationId: ORG, apartmentId: APT_1, ownerPartyId: OWNER, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.listing.create({ data: { id: LISTING_22, organizationId: ORG, apartmentId: APT_2, ownerPartyId: OWNER, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  // Tenancy for deposit FK
  await db.tenancy.create({ data: { id: TENANCY_21, organizationId: ORG, propertyId: PROP, unitId: LISTING_21, tenantPartyId: TENANT, tenancyCode: "T6R-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "2000.00" } });
  // ManagementFeeConfig — 10% + 8% SST
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });
  // Deposit collected in-month for APT_1 listing
  await db.deposit.create({
    data: {
      organizationId: ORG, tenancyId: TENANCY_21,
      partyId: TENANT, unitId: LISTING_21,
      type: "security", amount: "2000.00",
      status: "held", createdAt: MONTH_START,
    },
  });
  await db.ownerLedgerEntry.createMany({
    data: [
      // INCOME rows — must NOT appear in lineItems
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_1, listingId: LISTING_21, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "income", category: "rental_income", amount: "2000.00", paidBy: "tenant", includeInPayout: true, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_2, listingId: LISTING_22, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "income", category: "rental_income", amount: "1500.00", paidBy: "tenant", includeInPayout: true, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
      // EXPENSE rows — utilities_tnb and water must appear in lineItems
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_1, listingId: LISTING_21, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "expense", category: "utilities_tnb", amount: "207.35", paidBy: "kaen", includeInPayout: true, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_1, listingId: LISTING_21, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "expense", category: "water", amount: "9.10", paidBy: "kaen", includeInPayout: true, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
      // MANAGEMENT FEE expense — must NOT appear in lineItems (deferred)
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_1, listingId: LISTING_21, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "expense", category: "management_fee", amount: "216.00", paidBy: "kaen", includeInPayout: true, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
      // PAYOUT row — must NOT appear in lineItems (direction filter excludes it)
      { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT_1, listingId: LISTING_21, statementMonth: MONTH_START, transactionDate: MONTH_START, direction: "payout", category: "payout", amount: "1800.00", paidBy: "kaen", includeInPayout: false, taxCategory: "check_with_tax_agent", paymentStatus: "paid", status: "active", createdById: USER, updatedById: USER },
    ],
  });
}

// ─── Integration suite ─────────────────────────────────────────────────────────
dn("buildOwnerLedgerReceiptModel (integration, real DB)", () => {
  // For the integration suite, restore the real findOwnerLedgerRowsForMonth.
  beforeEach(async () => {
    const { findOwnerLedgerRowsForMonth: realFn } = await vi.importActual<
      typeof import("../../owner-billing/owner-statement-sections")
    >("../../owner-billing/owner-statement-sections");
    vi.mocked(findOwnerLedgerRowsForMonth).mockImplementation(realFn);

    // resolveOwnerPayoutForScope must NOT be called by the new receipt — leave it as
    // the default stub (returns undefined). If the service calls it, this will silently
    // return undefined; the integration tests below verify the receipt works correctly
    // WITHOUT payout-scope data.
    vi.mocked(resolveOwnerPayoutForScope).mockResolvedValue(undefined as never);

    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("(a) returns null when the apartment has no expense rows (EMPTY_APT scope)", async () => {
    const result = await buildOwnerLedgerReceiptModel(ctx, OWNER, MONTH, APT_EMPTY);
    expect(result).toBeNull();
  });

  it("(b) lineItems has expense rows + computed management fee; income/stored-mgmt_fee/payout excluded; footing matches statement deductibles", async () => {
    // Seed data: income APT_1=2000 + APT_2=1500, expense TNB=207.35+water=9.10 (APT_1 only),
    // stored management_fee=216 (excluded — superseded by computed fee below), payout=1800 (excluded).
    // Fee config: 10% + 8% SST.
    // Computed mgmt fee: 10% of (2000+1500) = 350 base, 8% SST = 28 → 378 total.
    const model = await buildOwnerLedgerReceiptModel(ctx, OWNER, MONTH, null);
    expect(model).not.toBeNull();

    const { lineItems, totals } = model!;

    // 3 line items: TNB, water, management fee (computed, NOT the stored management_fee row)
    expect(lineItems).toHaveLength(3);

    // No income rows
    expect(lineItems.every((li) => !["Rental Income", "Carpark Income"].includes(li.description))).toBe(true);

    // No payout row — the direction filter must exclude it entirely
    expect(lineItems.every((li) => li.description !== "payout")).toBe(true);

    // Each line has qty="1.00"
    expect(lineItems.every((li) => li.qty === "1.00")).toBe(true);

    // Management fee line present (computed fresh, not the stored row)
    const mgmtLine = lineItems.find((li) => li.description.toLowerCase().includes("management"));
    expect(mgmtLine).toBeDefined();
    expect(mgmtLine!.amount).toBe("350.00"); // 10% of (2000+1500)
    expect(mgmtLine!.tax).toBe("28.00");     // 8% SST on 350

    // FOOTING: subTotal + sst === total (cents-exact)
    const subTotalCents = Math.round(parseFloat(totals.subTotal) * 100);
    const sstCents      = Math.round(parseFloat(totals.sst) * 100);
    const totalCents    = Math.round(parseFloat(totals.total) * 100);
    expect(subTotalCents + sstCents).toBe(totalCents);

    // subTotal = 207.35 + 9.10 + 350.00 = 566.45
    expect(totals.subTotal).toBe("566.45");
    // sst = 0 + 0 + 28.00 = 28.00
    expect(totals.sst).toBe("28.00");
    // total DERIVED from computeOwnerPayout — foots to statement.deductibleExpensesC.
    // Using derivation rather than a hardcoded constant so future seed changes are caught.
    {
      const { getDb } = await import("@kason/db");
      const db = getDb();
      const allRows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, null);
      const feeConfigsForPayout = await db.managementFeeConfig.findMany({
        where: { organizationId: ORG, ownerPartyId: OWNER, isActive: true },
        select: { propertyId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, updatedAt: true },
      });
      const payout = computeOwnerPayout({
        rows: allRows as never,
        feeConfigRows: feeConfigsForPayout as never,
        depositCollectedC: 0,
      });
      expect(totals.total).toBe(centsToString(payout.deductibleExpensesC)); // "594.45"
    }
  });

  it("(c) apartmentId scope: expense rows + per-unit computed mgmt fee; scopeLabel = unitCode", async () => {
    // APT_1 scope: income=2000, expense TNB=207.35+water=9.10, stored mgmt_fee=216 (excluded).
    // Computed fee: 10% of 2000 = 200 base, 8% SST = 16 → 216 total.
    const model = await buildOwnerLedgerReceiptModel(ctx, OWNER, MONTH, APT_1);
    expect(model).not.toBeNull();

    const { lineItems, totals } = model!;

    // 3 line items: TNB, water, management fee (per-unit fee, income=2000 only)
    expect(lineItems).toHaveLength(3);
    expect(model!.header.property).toBe("A-01");

    // Per-unit management fee
    const mgmtLine = lineItems.find((li) => li.description.toLowerCase().includes("management"));
    expect(mgmtLine).toBeDefined();
    expect(mgmtLine!.amount).toBe("200.00"); // 10% of 2000 (APT_1 income only)
    expect(mgmtLine!.tax).toBe("16.00");     // 8% SST

    // total DERIVED from computeOwnerPayout (APT_1 scope) — foots to statement.deductibleExpensesC.
    {
      const { getDb } = await import("@kason/db");
      const db = getDb();
      const allRowsApt1 = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, APT_1);
      const feeConfigsForPayout = await db.managementFeeConfig.findMany({
        where: { organizationId: ORG, ownerPartyId: OWNER, isActive: true },
        select: { propertyId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, updatedAt: true },
      });
      const payout = computeOwnerPayout({
        rows: allRowsApt1 as never,
        feeConfigRows: feeConfigsForPayout as never,
        depositCollectedC: 0,
      });
      expect(totals.total).toBe(centsToString(payout.deductibleExpensesC)); // "432.45"
    }
  });

  it("(d) buildOwnerLedgerReceiptPdf: non-empty → Uint8Array starting with %PDF-; Date/Unit column headers absent", async () => {
    const bytes = await buildOwnerLedgerReceiptPdf(ctx, OWNER, MONTH, null);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Confirm the receipt HTML (inspected via the model) does not render
    // ledger-dump column headers that were removed in the receipt redesign.
    const model = await buildOwnerLedgerReceiptModel(ctx, OWNER, MONTH, null);
    expect(model).not.toBeNull();
    const html = renderOwnerLedgerReceiptHtml(model!, null);
    expect(html).not.toMatch(/<th[^>]*>Date<\/th>/);
    expect(html).not.toMatch(/<th[^>]*>Unit<\/th>/);
  });

  it("(e) receiptNo is deterministic IVOWN-<YYYYMM>-<scope> (fallback — no seeded DocumentSeries row); date is YYYY-MM-DD format", async () => {
    const model = await buildOwnerLedgerReceiptModel(ctx, OWNER, MONTH, null);
    expect(model).not.toBeNull();
    // receiptNo must start with "IVOWN-202607-" — this org (seedBase) has no
    // DocumentSeries row, so the fallback literal "IVOWN" is exercised here.
    expect(model!.header.receiptNo).toMatch(/^IVOWN-202607-/);
    // date must match YYYY-MM-DD
    expect(model!.header.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // title is always "Invoice"
    expect(model!.header.title).toBe("Invoice");
    // ownerName is resolved
    expect(model!.header.ownerName).toBe("T6R Owner Dato Razak");
    // period is the month label
    expect(model!.header.period).toBe("July 2026");
  });
});

// ─── Integration suite — Task 4: buildReceiptWithBillsPdf (receipt + attached bills) ─────
// Fixed disjoint UUIDs (a4 prefix — task-4-receipt-with-bills, unused by any other suite)
const T4_ORG       = "a4000000-0000-4000-8000-000000000001";
const T4_USER      = "a4000000-0000-4000-8000-000000000002";
const T4_PARTY     = "a4000000-0000-4000-8000-000000000003";
const T4_OWNER     = "a4000000-0000-4000-8000-000000000004";
const T4_PROP      = "a4000000-0000-4000-8000-000000000005";
const T4_APT       = "a4000000-0000-4000-8000-000000000011";

const T4_MONTH = "2026-08";
const T4_MONTH_START = new Date(Date.UTC(2026, 7, 1));

const t4ctx: OwnerBillingActorCtx = { orgId: T4_ORG, actorUserId: T4_USER, actorRole: "admin" };

async function t4Cleanup() {
  const { getDb } = await import("@kason/db");
  const db = getDb();
  const org = { organizationId: T4_ORG };
  await db.ownerExpenseProof.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: T4_USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: T4_ORG } });
}

async function t4SeedBase() {
  const { getDb } = await import("@kason/db");
  const db = getDb();
  await db.organization.create({ data: { id: T4_ORG, name: "T4 Bills Org", slug: "t4-receipt-bills-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.party.create({ data: { id: T4_PARTY, organizationId: T4_ORG, displayName: "T4 Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: T4_USER, organizationId: T4_ORG, email: "t4-op@example.com", fullName: "T4 Operator", status: "active", role: "admin", userType: "operator", partyId: T4_PARTY } });
  await db.party.create({ data: { id: T4_OWNER, organizationId: T4_ORG, displayName: "T4 Owner", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: T4_PROP, organizationId: T4_ORG, name: "T4 Property", propertyCode: "T4RP", propertyType: "apartment", addressLine1: "1 T4 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: T4_APT, organizationId: T4_ORG, propertyId: T4_PROP, unitCode: "T4-01", listingMode: "WHOLE" } });
  const LISTING = "a4000000-0000-4000-8000-000000000021";
  await db.listing.create({ data: { id: LISTING, organizationId: T4_ORG, apartmentId: T4_APT, ownerPartyId: T4_OWNER, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  // T4 needs an EXPENSE row (not just income) so buildOwnerLedgerReceiptModel returns non-null
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: T4_ORG, ownerPartyId: T4_OWNER, propertyId: T4_PROP,
      apartmentId: T4_APT, listingId: LISTING,
      statementMonth: T4_MONTH_START, transactionDate: T4_MONTH_START,
      direction: "expense", category: "utilities_tnb", amount: "150.00",
      paidBy: "kaen", includeInPayout: true, taxCategory: "check_with_tax_agent",
      paymentStatus: "paid", status: "active", createdById: T4_USER, updatedById: T4_USER,
    },
  });
}

/** A real 1-page PDF (generated by pdf-lib — guaranteed loadable). */
async function t4OnePagePdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  return Buffer.from(await d.save());
}

dn("buildReceiptWithBillsPdf (integration, Task 4)", () => {
  const mockFetchStorage = vi.mocked(fetchStorageBuffer);
  const mockHtmlToPdf = vi.mocked(htmlToPdf);

  beforeEach(async () => {
    vi.clearAllMocks();

    // Restore the real findOwnerLedgerRowsForMonth for integration tests.
    const { findOwnerLedgerRowsForMonth: realFn } = await vi.importActual<
      typeof import("../../owner-billing/owner-statement-sections")
    >("../../owner-billing/owner-statement-sections");
    vi.mocked(findOwnerLedgerRowsForMonth).mockImplementation(realFn);

    // resolveOwnerPayoutForScope must NOT be called by the new receipt.
    vi.mocked(resolveOwnerPayoutForScope).mockResolvedValue(undefined as never);

    // Restore the real getTemplateForOrgDocType so T4 tests exercise the real letterhead
    // path. The T4 org seeds no DocumentTemplate row, so the real fn returns undefined →
    // the receipt renders with the graceful no-letterhead fallback (null template), which
    // is expected and all assertions still pass.
    const { getTemplateForOrgDocType: realGetTemplate } = await vi.importActual<
      typeof import("../../../lib/document-templates/service")
    >("../../../lib/document-templates/service");
    vi.mocked(getTemplateForOrgDocType).mockImplementation(realGetTemplate);

    // htmlToPdf: return a REAL 1-page PDF so PDFDocument.load can parse it and
    // we can meaningfully compare page counts (the default fake "%PDF-1.4 fake"
    // is not parseable by pdf-lib).
    const baseReceiptPdf = await t4OnePagePdf();
    mockHtmlToPdf.mockResolvedValue(baseReceiptPdf);

    // Default: no storage bytes (no proofs scenario).
    mockFetchStorage.mockResolvedValue(null);

    await t4Cleanup();
    await t4SeedBase();
  });

  afterAll(async () => {
    await t4Cleanup();
  });

  it("(T4-a) with 1 attached proof → page count > bills-free receipt", async () => {
    const { getDb } = await import("@kason/db");
    const db = getDb();

    // Seed 1 OwnerExpenseProof row with a real PDF storageKey.
    await db.ownerExpenseProof.create({
      data: {
        organizationId: T4_ORG,
        ownerPartyId: T4_OWNER,
        statementMonth: T4_MONTH_START,
        apartmentId: T4_APT,
        category: "utilities_tnb",
        storageKey: "t4/tnb-bill.pdf",
        filename: "tnb-bill.pdf",
        uploadedById: T4_USER,
      },
    });

    // Make fetchStorageBuffer return a real 1-page PDF for this key.
    const billPdf = await t4OnePagePdf();
    mockFetchStorage.mockImplementation(async (key: string) =>
      key === "t4/tnb-bill.pdf" ? billPdf : null,
    );

    // Bills-free receipt page count
    const receiptOnly = await buildOwnerLedgerReceiptPdf(t4ctx, T4_OWNER, T4_MONTH, T4_APT);
    expect(receiptOnly).not.toBeNull();
    const receiptOnlyPagesCount = (await PDFDocument.load(receiptOnly!)).getPageCount();

    // Composed receipt + bill.
    const composed = await buildReceiptWithBillsPdf(t4ctx, T4_OWNER, T4_MONTH, T4_APT);
    expect(composed).not.toBeNull();
    const composedDoc = await PDFDocument.load(composed!);
    expect(composedDoc.getPageCount()).toBeGreaterThan(receiptOnlyPagesCount);
  });

  it("(T4-b) with NO proofs → same page count as bills-free buildOwnerLedgerReceiptPdf", async () => {
    // No proofs seeded; fetchStorageBuffer returns null by default.
    const receiptOnly = await buildOwnerLedgerReceiptPdf(t4ctx, T4_OWNER, T4_MONTH, T4_APT);
    const composed = await buildReceiptWithBillsPdf(t4ctx, T4_OWNER, T4_MONTH, T4_APT);

    expect(composed).not.toBeNull();
    expect(receiptOnly).not.toBeNull();

    const receiptOnlyDoc = await PDFDocument.load(receiptOnly!);
    const composedDoc = await PDFDocument.load(composed!);
    expect(composedDoc.getPageCount()).toBe(receiptOnlyDoc.getPageCount());
  });

  it("(T4-c) with no expense ledger rows → null", async () => {
    // Uses a future statementMonth (2099-01) with no seeded rows for T4_OWNER/T4_APT,
    // so buildReceiptWithBillsPdf gets an empty row set and returns null.
    const bytes = await buildReceiptWithBillsPdf(t4ctx, T4_OWNER, "2099-01", T4_APT);
    expect(bytes).toBeNull();
  });
});

// ─── Unit suite — null-vs-bytes contract (always runs, no DB) ─────────────────
describe("buildOwnerLedgerReceiptPdf — null-vs-bytes contract (mocked)", () => {
  const mockFindRows = vi.mocked(findOwnerLedgerRowsForMonth);
  const mockTemplate = vi.mocked(getTemplateForOrgDocType);
  const unitCtx: OwnerBillingActorCtx = { orgId: "unit-org", actorUserId: "unit-user", actorRole: "admin" };

  // Minimal stub template for the unit suite letterhead tests.
  const STUB_TEMPLATE = {
    id: "tpl-1",
    organizationId: "unit-org",
    docType: "owner_statement" as const,
    title: "Owner Statement",
    refPrefix: "",
    refSeparator: "-",
    refPadding: 5,
    refIncludeYear: false,
    headerFields: {
      showLogo: false,
      showRegNo: true,
      showSalesTaxId: false,
      showServiceTaxId: false,
      showAddress: false,
      showEmail: false,
      showContact: false,
    },
    orgName: "KAEN Sdn Bhd",
    orgRegNo: "1234567-X",
    orgSalesTaxId: null,
    orgServiceTaxId: null,
    orgAddressLines: [],
    orgEmail: null,
    orgContact: null,
    logoUrl: null,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockTemplate.mockResolvedValue(STUB_TEMPLATE);

    // Default DB stub: no fee config → computedMgmtTotalC = 0, so the null-return
    // tests (empty rows / income-only) hit the guard before listing/party queries.
    // The "returns Uint8Array" test overrides this with its own explicit stubs.
    const { getDb } = await import("@kason/db");
    const stub = getDb() as never as Record<string, object>;
    stub.managementFeeConfig = { findMany: vi.fn(async () => []) };
    // documentSeries: default to a resolved IVOWN row so tests that reach past
    // the null guard (i.e. actually build a model) don't crash on the new
    // prefix lookup; the null-return tests never reach this call at all.
    stub.documentSeries = { findFirst: vi.fn(async () => ({ prefix: "IVOWN" })) };
  });

  it("returns null when no rows exist for the given scope", async () => {
    mockFindRows.mockResolvedValue([]);
    const result = await buildOwnerLedgerReceiptPdf(unitCtx, "owner-1", "2026-07", "empty-apt");
    expect(result).toBeNull();
  });

  it("returns null when only income rows exist (no expense rows)", async () => {
    mockFindRows.mockResolvedValue([
      {
        id: "row-inc",
        organizationId: "unit-org",
        ownerPartyId: "owner-1",
        propertyId: "prop-1",
        apartmentId: null,
        listingId: null,
        tenancyId: null,
        statementMonth: new Date("2026-07-01"),
        transactionDate: new Date("2026-07-01"),
        direction: "income",
        category: "rental_income",
        description: null,
        remarks: null,
        amount: { toString: () => "2000.00" } as never,
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "check_with_tax_agent",
        includeInPayout: true,
        attachmentKeys: [],
        sourceType: "manual",
        sourceChargeId: null,
        sourceInvoiceId: null,
        sourceUtilityBillId: null,
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
        status: "active",
        createdById: "unit-user",
        updatedById: "unit-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const result = await buildOwnerLedgerReceiptPdf(unitCtx, "owner-1", "2026-07", null);
    expect(result).toBeNull();
  });

  it("returns Uint8Array starting with %PDF- when expense rows exist", async () => {
    mockFindRows.mockResolvedValue([
      // income row — filtered out
      {
        id: "row-inc",
        organizationId: "unit-org",
        ownerPartyId: "owner-1",
        propertyId: "prop-1",
        apartmentId: null,
        listingId: null,
        tenancyId: null,
        statementMonth: new Date("2026-07-01"),
        transactionDate: new Date("2026-07-01"),
        direction: "income",
        category: "rental_income",
        description: null,
        remarks: null,
        amount: { toString: () => "2000.00" } as never,
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "check_with_tax_agent",
        includeInPayout: true,
        attachmentKeys: [],
        sourceType: "manual",
        sourceChargeId: null,
        sourceInvoiceId: null,
        sourceUtilityBillId: null,
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
        status: "active",
        createdById: "unit-user",
        updatedById: "unit-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      // expense row — included
      {
        id: "row-exp",
        organizationId: "unit-org",
        ownerPartyId: "owner-1",
        propertyId: "prop-1",
        apartmentId: null,
        listingId: null,
        tenancyId: null,
        statementMonth: new Date("2026-07-01"),
        transactionDate: new Date("2026-07-01"),
        direction: "expense",
        category: "utilities_tnb",
        description: null,
        remarks: null,
        amount: { toString: () => "207.35" } as never,
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "check_with_tax_agent",
        includeInPayout: true,
        attachmentKeys: [],
        sourceType: "manual",
        sourceChargeId: null,
        sourceInvoiceId: null,
        sourceUtilityBillId: null,
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
        status: "active",
        createdById: "unit-user",
        updatedById: "unit-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const { getDb: mockGetDb } = await import("@kason/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = mockGetDb() as any;
    stub.managementFeeConfig = { findMany: vi.fn(async () => []) }; // no fee config → no mgmt fee line
    stub.listing = { findMany: vi.fn(async () => []) };
    stub.party = { findFirst: vi.fn(async () => ({ displayName: "Test Owner" })) };

    const bytes = await buildOwnerLedgerReceiptPdf(unitCtx, "owner-1", "2026-07", null);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  // Regression guard: this is the ONE caller allowed to opt in to tolerating a
  // logo-signing failure (getTemplateForOrgDocType's default is now loud-fail —
  // see apps/api/src/lib/document-templates/service.ts). buildOwnerLedgerReceiptPdf
  // is a pure-read, non-persisted, non-portal-visible on-demand PDF, so a missing
  // logo here is low-stakes — unlike the owner-statement regenerate / reservation
  // customer-sign paths, which must keep failing loudly by default.
  it("opts in to tolerant logo resolution via getTemplateForOrgDocType(..., { tolerateLogoFailure: true })", async () => {
    mockFindRows.mockResolvedValue([
      {
        id: "row-exp",
        organizationId: "unit-org",
        ownerPartyId: "owner-1",
        propertyId: "prop-1",
        apartmentId: null,
        listingId: null,
        tenancyId: null,
        statementMonth: new Date("2026-07-01"),
        transactionDate: new Date("2026-07-01"),
        direction: "expense",
        category: "utilities_tnb",
        description: null,
        remarks: null,
        amount: { toString: () => "207.35" } as never,
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "check_with_tax_agent",
        includeInPayout: true,
        attachmentKeys: [],
        sourceType: "manual",
        sourceChargeId: null,
        sourceInvoiceId: null,
        sourceUtilityBillId: null,
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
        status: "active",
        createdById: "unit-user",
        updatedById: "unit-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const { getDb: mockGetDb } = await import("@kason/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = mockGetDb() as any;
    stub.managementFeeConfig = { findMany: vi.fn(async () => []) };
    stub.listing = { findMany: vi.fn(async () => []) };
    stub.party = { findFirst: vi.fn(async () => ({ displayName: "Test Owner" })) };

    await buildOwnerLedgerReceiptPdf(unitCtx, "owner-1", "2026-07", null);

    expect(mockTemplate).toHaveBeenCalledWith("unit-org", "owner_statement", {
      tolerateLogoFailure: true,
    });
  });
});

// ─── Unit suite — renderOwnerLedgerReceiptHtml (always runs, no DB) ────────────
describe("renderOwnerLedgerReceiptHtml — clean invoice layout", () => {
  /**
   * renderOwnerLedgerReceiptHtml is a pure function (model + template → HTML string).
   * Assertions:
   *   (a) The rendered HTML contains the org name and reg number from the template
   *   (b) Title is "Expense Receipt" (NOT "Expense Statement", NOT "Ledger Receipt")
   *   (c) Invoice columns present: Description, Qty, Unit Price, Amount, Tax
   *   (d) Ledger-dump columns ABSENT: Direction, Payment Status, Date (column header), Unit (column)
   *   (e) Payout totals ABSENT: "Net Payout", "Income Collected", "Deposit Collected", "Deductible Expenses"
   *   (f) Clean invoice totals present: "Sub Total", "Sales & Service Tax", "Total"
   *   (g) Computer-generated footer present
   *   (h) Line item rows render description/qty/unit price/amount/tax
   *   (i) ownerName + period + property in the info block
   *   (j) omits reg number when showRegNo=false
   */

  const STUB_TEMPLATE_WITH_REG = {
    id: "tpl-lh",
    organizationId: "unit-org",
    docType: "owner_statement" as const,
    title: "Owner Statement",
    refPrefix: "",
    refSeparator: "-",
    refPadding: 5,
    refIncludeYear: false,
    headerFields: {
      showLogo: false,
      showRegNo: true,
      showSalesTaxId: false,
      showServiceTaxId: false,
      showAddress: false,
      showEmail: false,
      showContact: false,
    },
    orgName: "KAEN Sdn Bhd",
    orgRegNo: "1234567-X",
    orgSalesTaxId: null,
    orgServiceTaxId: null,
    orgAddressLines: [],
    orgEmail: null,
    orgContact: null,
    logoUrl: null,
  };

  const STUB_TEMPLATE_NO_REG = {
    ...STUB_TEMPLATE_WITH_REG,
    headerFields: { ...STUB_TEMPLATE_WITH_REG.headerFields, showRegNo: false },
  };

  const MINIMAL_MODEL = {
    header: {
      template: null as typeof STUB_TEMPLATE_WITH_REG | null,
      title: "Invoice" as const,
      receiptNo: "RCP-202607-A-10-04",
      date: "2026-06-30",
      property: "A-10-04",
      ownerName: "Dato Razak",
      period: "July 2026",
    },
    lineItems: [
      {
        description: "Electricity (TNB)",
        billingPeriod: "July 2026",
        qty: "1.00",
        unitPrice: "207.35",
        amount: "207.35",
        tax: "0.00",
      },
      {
        description: "Water",
        billingPeriod: "July 2026",
        qty: "1.00",
        unitPrice: "9.10",
        amount: "9.10",
        tax: "0.00",
      },
    ],
    totals: {
      subTotal: "216.45",
      sst: "0.00",
      total: "216.45",
    },
  };

  it("(a) includes orgName + orgRegNo in the letterhead when showRegNo=true", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("KAEN Sdn Bhd");
    expect(html).toContain("1234567-X");
    expect(html).not.toContain("<h1>Ledger Receipt</h1>");
  });

  it("(b) title is 'Invoice' (not Expense Receipt, not Expense Statement, not Ledger Receipt)", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("Invoice");
    expect(html).not.toContain("Expense Receipt");
    expect(html).not.toContain("Expense Statement");
    expect(html).not.toContain("Ledger Receipt");
  });

  it("(k) letterhead band, standalone fallback and <title> all print the SAME title sourced from model.header.title — not an independently hardcoded literal (regression guard)", () => {
    // Cast bypasses the header.title literal-type pin (currently fixed to "Invoice")
    // purely to prove the renderer SOURCES the printed title from the model field
    // rather than a second hardcoded string. Historically renderLetterheadBand and
    // standaloneTitle each hardcoded "Expense Receipt" independently of this field —
    // this probe would have caught that drift.
    const probeTitle = "PROBE-TITLE-XYZ";
    const probeModel = {
      ...MINIMAL_MODEL,
      header: { ...MINIMAL_MODEL.header, title: probeTitle },
    } as unknown as typeof MINIMAL_MODEL;

    const htmlWithBand = renderOwnerLedgerReceiptHtml(probeModel, STUB_TEMPLATE_WITH_REG);
    expect(htmlWithBand).toContain(`<div class="lh-title">${probeTitle}</div>`);
    expect(htmlWithBand).toContain(`<title>${probeTitle}</title>`);

    const htmlNoTemplate = renderOwnerLedgerReceiptHtml(probeModel, null);
    expect(htmlNoTemplate).toContain(`<div class="standalone-title">${probeTitle}</div>`);
  });

  it("(l) letterhead band uses a 3-zone grid (logo | center | title) with centered org name and a right-aligned uppercase bold title — mirrors render.ts .doc-header", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);

    // 3-zone grid — logo | center | title — matching render.ts's .doc-header layout
    // (grid-template-columns: 1fr 2fr 1fr), not the old imbalanced flex layout.
    expect(html).toMatch(/\.lh-band\s*\{[^}]*display:\s*grid/);
    expect(html).toMatch(/\.lh-band\s*\{[^}]*grid-template-columns:\s*1fr 2fr 1fr/);
    // Bottom rule under the header is retained.
    expect(html).toMatch(/\.lh-band\s*\{[^}]*border-bottom:\s*1px solid #d1d5db/);
    // Org name + meta lines centered in the middle zone.
    expect(html).toMatch(/\.lh-center\s*\{[^}]*text-align:\s*center/);
    // Title right-aligned, uppercase, bold — like .zone-right h2 in render.ts.
    expect(html).toMatch(/\.lh-title\s*\{[^}]*text-align:\s*right/);
    expect(html).toMatch(/\.lh-title\s*\{[^}]*text-transform:\s*uppercase/);
    expect(html).toMatch(/\.lh-title\s*\{[^}]*font-weight:\s*700/);

    // Zone DOM order: logo, then center, then title (left-to-right reading order).
    const logoIdx = html.indexOf('class="lh-logo"');
    const centerIdx = html.indexOf('class="lh-center"');
    const titleIdx = html.indexOf('class="lh-title"');
    expect(logoIdx).toBeGreaterThan(-1);
    expect(logoIdx).toBeLessThan(centerIdx);
    expect(centerIdx).toBeLessThan(titleIdx);
  });

  it("(c) invoice columns present: Description, Qty, Unit Price, Amount, Tax", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("Description");
    expect(html).toContain("Qty");
    expect(html).toContain("Unit Price");
    expect(html).toContain("Amount");
    expect(html).toContain("Tax");
  });

  it("(d) ledger-dump columns ABSENT: Direction, Payment Status", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    // These exact column headers must not appear
    expect(html).not.toMatch(/\bDirection\b/);
    expect(html).not.toMatch(/Payment Status/);
  });

  it("(e) payout totals ABSENT: Net Payout, Income Collected, Deposit Collected, Deductible Expenses", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).not.toContain("Net Payout");
    expect(html).not.toContain("Income Collected");
    expect(html).not.toContain("Deposit Collected");
    expect(html).not.toContain("Deductible Expenses");
  });

  it("(f) invoice totals present: Sub Total, Sales & Service Tax, Total", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("Sub Total");
    expect(html).toContain("Sales &amp; Service Tax");
    expect(html).toContain("216.45");
    expect(html).toContain("0.00");
  });

  it("(g) computer-generated footer present, worded as an invoice (not a receipt)", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("This is a computer-generated invoice. No signature required.");
    expect(html).not.toContain("computer-generated receipt");
  });

  it("(h) line item rows render description, qty, unit price, amount, tax", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("Electricity (TNB)");
    expect(html).toContain("207.35");
    expect(html).toContain("1.00");
    expect(html).toContain("Water");
    expect(html).toContain("9.10");
  });

  it("(i) ownerName, period, property in the info block", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_WITH_REG);
    expect(html).toContain("Dato Razak");
    expect(html).toContain("July 2026");
    expect(html).toContain("A-10-04");
  });

  it("(j) omits reg number when showRegNo=false", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, STUB_TEMPLATE_NO_REG);
    expect(html).toContain("KAEN Sdn Bhd");
    expect(html).not.toContain("1234567-X");
  });

  it("renders with null template — no letterhead, body still present", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, null);
    expect(html).toContain("Invoice");
    expect(html).toContain("computer-generated");
    expect(html).not.toContain("KAEN Sdn Bhd");
  });

  it("renders with null template — standalone title is centered (not bare-left), defense-in-depth", () => {
    const html = renderOwnerLedgerReceiptHtml(MINIMAL_MODEL, null);
    expect(html).toContain('<div class="standalone-title">Invoice</div>');
    expect(html).toMatch(/\.standalone-title\s*\{[^}]*text-align:\s*center/);
  });
});

// ─── Unit suite — Task 4: management fee footing ─────────────────────────────
//
// TDD: these tests are written FIRST (RED) to confirm the fee is currently
// excluded, then the implementation is added to make them GREEN.
//
// Acceptance gate (task-4-brief.md):
//   (a) A "Management Fee" line item appears in the receipt (base in Amount, SST in Tax).
//   (b) receipt.totals.total === centsToString(deductibleExpensesC) from computeOwnerPayout
//       for BOTH the all-units scope and a single-apartment scope.
//
describe("buildOwnerLedgerReceiptModel — management fee footing (Task 4)", () => {
  const mockFindRows = vi.mocked(findOwnerLedgerRowsForMonth);
  const mgmtFeeCtx: OwnerBillingActorCtx = {
    orgId: "mgmt-org",
    actorUserId: "mgmt-user",
    actorRole: "admin",
  };

  // Decimal-like mock (Prisma Decimal structural equivalent)
  function dec(s: string) {
    return { toString: () => s } as never;
  }

  // Full-shape income row (all fields Prisma includes)
  function incomeRow(id: string, amount: string, propertyId = "prop-1") {
    return {
      id,
      organizationId: "mgmt-org",
      ownerPartyId: "mgmt-owner",
      propertyId,
      apartmentId: "apt-1",
      listingId: "listing-1",
      tenancyId: null,
      statementMonth: new Date("2026-07-01"),
      transactionDate: new Date("2026-07-01"),
      direction: "income",
      category: "rental_income",
      description: null,
      remarks: null,
      amount: dec(amount),
      sstAmount: null,
      paidBy: "tenant",
      paymentStatus: "paid",
      taxCategory: "check_with_tax_agent",
      includeInPayout: true,
      attachmentKeys: [],
      sourceType: "manual",
      sourceChargeId: null,
      sourceInvoiceId: null,
      sourceUtilityBillId: null,
      payeeName: null,
      paidOnBehalfRef: null,
      paidOnBehalfDate: null,
      status: "active",
      createdById: "mgmt-user",
      updatedById: "mgmt-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // Full-shape expense row.
  // opts.includeInPayout — defaults to true (KAEN-paid deductible); set false for:
  //   - Source-2 display-only utility twins (same category as Source-3 full bill)
  //   - Owner-paid expenses (paidBy:"owner", not deductible from payout)
  // opts.paidBy — defaults to "kaen"
  function expenseRow(
    id: string,
    category: string,
    amount: string,
    opts: { includeInPayout?: boolean; paidBy?: string } = {},
  ) {
    return {
      id,
      organizationId: "mgmt-org",
      ownerPartyId: "mgmt-owner",
      propertyId: "prop-1",
      apartmentId: "apt-1",
      listingId: "listing-1",
      tenancyId: null,
      statementMonth: new Date("2026-07-01"),
      transactionDate: new Date("2026-07-01"),
      direction: "expense",
      category,
      description: null,
      remarks: null,
      amount: dec(amount),
      sstAmount: null,
      paidBy: opts.paidBy ?? "kaen",
      paymentStatus: "paid",
      taxCategory: "check_with_tax_agent",
      includeInPayout: opts.includeInPayout ?? true,
      attachmentKeys: [],
      sourceType: "manual",
      sourceChargeId: null,
      sourceInvoiceId: null,
      sourceUtilityBillId: null,
      payeeName: null,
      paidOnBehalfRef: null,
      paidOnBehalfDate: null,
      status: "active",
      createdById: "mgmt-user",
      updatedById: "mgmt-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // Fee config stub: 10% fee + 8% SST, all-properties scope.
  const FEE_CONFIG = {
    propertyId: null as string | null,
    feeType: "percent",
    feeValue: dec("10.00"),
    capAmount: null as never,
    sstPercent: dec("8.00"),
    updatedAt: new Date(),
  };

  // Helper: set up the getDb() stub for a test
  async function stubDb(feeConfigs: typeof FEE_CONFIG[]) {
    const { getDb } = await import("@kason/db");
    const stub = getDb() as never as Record<string, unknown>;
    (stub as never as Record<string, object>).managementFeeConfig = {
      findMany: vi.fn(async () => feeConfigs),
    };
    (stub as never as Record<string, object>).listing = {
      findMany: vi.fn(async () => []),
    };
    (stub as never as Record<string, object>).party = {
      findFirst: vi.fn(async () => ({ displayName: "Dato Razak" })),
    };
    // documentSeries: default resolved IVOWN row — this suite's tests all
    // build a non-null model, so they all reach the new prefix lookup.
    (stub as never as Record<string, object>).documentSeries = {
      findFirst: vi.fn(async () => ({ prefix: "IVOWN" })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(T4-1) RED: receipt currently has NO Management Fee line — confirms feat is missing", async () => {
    // Single apartment: rental_income 2000 + utilities_tnb 207.35
    mockFindRows.mockResolvedValue([
      incomeRow("inc-1", "2000.00"),
      expenseRow("exp-1", "utilities_tnb", "207.35"),
    ] as never);
    await stubDb([FEE_CONFIG]);

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", null);
    expect(model).not.toBeNull();

    // Currently FAILS: management fee is excluded (category !== "management_fee" filter).
    // After implementation this assertion becomes the GREEN check.
    const mgmtLine = model!.lineItems.find((li) =>
      li.description.toLowerCase().includes("management fee"),
    );
    expect(mgmtLine).toBeDefined(); // RED before impl: undefined
    expect(mgmtLine!.amount).toBe("200.00");
    expect(mgmtLine!.tax).toBe("16.00");
  });

  it("(T4-2) footing: receipt.total === statement deductibleExpensesC (all-units scope)", async () => {
    // Two income rows + one expense row.
    //   fee: 10% of 2000 = 200 base + 16 SST; 10% of 1500 = 150 base + 12 SST
    //   total mgmt fee: 350 base + 28 SST = 378
    //   expense non-mgmt: 207.35
    //   deductibleExpensesC = 20735 + 37800 = 58535 → 585.35
    const rows = [
      incomeRow("inc-1", "2000.00"),
      incomeRow("inc-2", "1500.00"),
      expenseRow("exp-1", "utilities_tnb", "207.35"),
    ] as never;
    mockFindRows.mockResolvedValue(rows);
    await stubDb([FEE_CONFIG]);

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", null);
    expect(model).not.toBeNull();

    // Compute expected deductibleExpensesC using the real computeOwnerPayout
    const payout = computeOwnerPayout({
      rows: rows as never,
      feeConfigRows: [FEE_CONFIG] as never,
      depositCollectedC: 0,
    });
    const expectedTotal = centsToString(payout.deductibleExpensesC);

    // RED before impl: receipt.total = 207.35 (no mgmt fee), payout.deductible = 585.35
    expect(model!.totals.total).toBe(expectedTotal);
  });

  it("(T4-3) footing: receipt.total === statement deductibleExpensesC (single-apartment scope)", async () => {
    // Per-unit scope: findOwnerLedgerRowsForMonth already scoped by the DB query.
    // We mock it to return only apt-1 rows.
    //   fee: 10% of 2000 = 200 base + 16 SST = 216
    //   expense: 207.35
    //   deductibleExpensesC = 20735 + 21600 = 42335 → 423.35
    const rows = [
      incomeRow("inc-1", "2000.00"),
      expenseRow("exp-1", "utilities_tnb", "207.35"),
    ] as never;
    mockFindRows.mockResolvedValue(rows);
    await stubDb([FEE_CONFIG]);

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", "apt-1");
    expect(model).not.toBeNull();

    const payout = computeOwnerPayout({
      rows: rows as never,
      feeConfigRows: [FEE_CONFIG] as never,
      depositCollectedC: 0,
    });
    const expectedTotal = centsToString(payout.deductibleExpensesC);

    // RED before impl: receipt.total = 207.35, expected = 423.35
    expect(model!.totals.total).toBe(expectedTotal);
  });

  it("(T4-4) no fee config → no Management Fee line and total unchanged", async () => {
    // No fee config → computedMgmtTotalC === 0 → no mgmt fee line
    mockFindRows.mockResolvedValue([
      incomeRow("inc-1", "2000.00"),
      expenseRow("exp-1", "utilities_tnb", "207.35"),
    ] as never);
    await stubDb([]); // empty fee config

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", null);
    expect(model).not.toBeNull();
    // No management fee line when no config
    expect(model!.lineItems.find((li) => li.description.toLowerCase().includes("management"))).toBeUndefined();
    // Total unchanged (just the expense)
    expect(model!.totals.total).toBe("207.35");
  });

  it("(T4-5) FOOTING — utility twin double-count: Source-2 twin (includeInPayout:false) must be excluded, receipt.total === deductibleExpensesC", async () => {
    // GROSS billing model produces TWO rows per utility:
    //   - Source-2 display-only twin (includeInPayout:false) — the statement suppresses this
    //   - Source-3 full supplier bill (includeInPayout:true)  — the statement counts this
    // The current receipt filter (category !== "management_fee") includes BOTH → double-counts.
    // Fix: use the same isSuppressedFromSection5 predicate the statement uses.
    //
    // Fixture:
    //   income: rental 2000
    //   Source-2 twin: utilities_tnb, 300, includeInPayout:false  ← display-only, must be excluded
    //   Source-3 full: utilities_tnb, 300, includeInPayout:true   ← full supplier bill, must be included
    //
    // computeOwnerPayout: twin suppressed → nonFeeDeductibleC = 300 (full bill only)
    //   mgmt fee: 10% of 2000 = 200 base + 16 SST = 216
    //   deductibleExpensesC = 300 + 216 = 516 → "516.00"
    //
    // Before filter fix: receipt includes twin + full → total = 300+300+216 = 816 ≠ 516 (WRONG)
    // After filter fix:  receipt includes full only  → total = 300+216 = 516 = deductibleExpensesC ✓
    const rows = [
      incomeRow("inc-1", "2000.00"),
      expenseRow("twin-1", "utilities_tnb", "300.00", { includeInPayout: false }),  // Source-2 twin
      expenseRow("full-1", "utilities_tnb", "300.00", { includeInPayout: true }),   // Source-3 full bill
    ] as never;
    mockFindRows.mockResolvedValue(rows);
    await stubDb([FEE_CONFIG]);

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", null);
    expect(model).not.toBeNull();

    const payout = computeOwnerPayout({
      rows: rows as never,
      feeConfigRows: [FEE_CONFIG] as never,
      depositCollectedC: 0,
    });
    const expectedTotal = centsToString(payout.deductibleExpensesC); // "516.00"

    // RED before filter fix: twin included → total = "816.00" ≠ "516.00"
    // GREEN after fix: twin excluded → total = "516.00" = "516.00" ✓
    expect(model!.totals.total).toBe(expectedTotal);

    // The twin must NOT appear as a separate line item — only the full bill is listed once
    const tnbLines = model!.lineItems.filter((li) =>
      li.description.toLowerCase().includes("electricity"),
    );
    expect(tnbLines).toHaveLength(1);
    expect(tnbLines[0]!.amount).toBe("300.00");
  });

  it("(T4-6) FOOTING — owner-paid expense (includeInPayout:false) must be excluded from receipt total, receipt.total === deductibleExpensesC", async () => {
    // deriveIncludeInPayout sets includeInPayout:false when paidBy !== "kaen".
    // The statement excludes these from deductibleExpensesC (shows as a non-income memo line).
    // The current receipt filter (category !== "management_fee") INCLUDES them → overstates total.
    // Fix: require e.includeInPayout === true in the expense filter.
    //
    // Fixture:
    //   income: rental 2000
    //   owner-paid expense: maintenance, 100, includeInPayout:false, paidBy:"owner"
    //
    // computeOwnerPayout: maintenance is NOT in SECTION5_DISPLAY_ONLY_UTILITY_CATEGORIES,
    //   so isSuppressedFromSection5("maintenance", false) = false → in nonFeeAllExpensesC,
    //   but includeInPayout:false → NOT in nonFeeDeductibleC.
    //   mgmt fee: 10% of 2000 = 200 base + 16 SST = 216
    //   deductibleExpensesC = 0 + 216 = 216 → "216.00"
    //
    // Before filter fix: receipt total = 100 (maintenance) + 216 (mgmt) = 316.00 ≠ 216.00 (WRONG)
    // After filter fix:  receipt total = 216.00 = deductibleExpensesC ✓
    const rows = [
      incomeRow("inc-1", "2000.00"),
      expenseRow("exp-owner", "maintenance", "100.00", {
        includeInPayout: false,
        paidBy: "owner",
      }),
    ] as never;
    mockFindRows.mockResolvedValue(rows);
    await stubDb([FEE_CONFIG]);

    const model = await buildOwnerLedgerReceiptModel(mgmtFeeCtx, "mgmt-owner", "2026-07", null);
    expect(model).not.toBeNull();

    const payout = computeOwnerPayout({
      rows: rows as never,
      feeConfigRows: [FEE_CONFIG] as never,
      depositCollectedC: 0,
    });
    const expectedTotal = centsToString(payout.deductibleExpensesC); // "216.00"

    // RED before filter fix: owner-paid maintenance included → total = "316.00" ≠ "216.00"
    // GREEN after fix: owner-paid excluded → total = "216.00" = "216.00" ✓
    expect(model!.totals.total).toBe(expectedTotal);

    // The owner-paid maintenance must NOT appear as a line item in the receipt
    const maintLine = model!.lineItems.find((li) =>
      li.description.toLowerCase().includes("maintenance"),
    );
    expect(maintLine).toBeUndefined();
  });
});

// ─── Unit suite — receiptNo IVOWN series prefix (owner-receipt-invoice fix) ───
//
// The printed receiptNo prefix must be SOURCED from the org's owner-document
// accounting series (DocumentSeries where code="IVOWN"), never hardcoded and
// never the tenant-side IVTEN series — falling back to the literal "IVOWN"
// only when the org has no such row yet (DocumentSeries rows are lazily
// seeded per-org, see charge-categories/seed.ts — a freshly created org has
// none until something seeds them).
//
// (m)/(n)/(p) use a DISTINCTIVE mocked prefix ("ZZZOWN") rather than literally
// "IVOWN" so the test cannot be satisfied by coincidence with the fallback
// literal — it proves the value is actually read from the table.
describe("buildOwnerLedgerReceiptModel — receiptNo IVOWN series prefix", () => {
  const mockFindRows = vi.mocked(findOwnerLedgerRowsForMonth);
  const ivOwnCtx: OwnerBillingActorCtx = {
    orgId: "ivown-org",
    actorUserId: "ivown-user",
    actorRole: "admin",
  };

  // Minimal single expense row — just enough to clear the null-return guard
  // (direction:"expense", includeInPayout:true, not suppressed).
  function oneExpenseRow() {
    return [
      {
        id: "row-exp",
        organizationId: "ivown-org",
        ownerPartyId: "owner-1",
        propertyId: "prop-1",
        apartmentId: null,
        listingId: null,
        tenancyId: null,
        statementMonth: new Date("2026-07-01"),
        transactionDate: new Date("2026-07-01"),
        direction: "expense",
        category: "utilities_tnb",
        description: null,
        remarks: null,
        amount: { toString: () => "100.00" } as never,
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "check_with_tax_agent",
        includeInPayout: true,
        attachmentKeys: [],
        sourceType: "manual",
        sourceChargeId: null,
        sourceInvoiceId: null,
        sourceUtilityBillId: null,
        payeeName: null,
        paidOnBehalfRef: null,
        paidOnBehalfDate: null,
        status: "active",
        createdById: "ivown-user",
        updatedById: "ivown-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindRows.mockResolvedValue(oneExpenseRow());
    const { getDb: mockGetDb } = await import("@kason/db");
    const stub = mockGetDb() as never as Record<string, object>;
    stub.managementFeeConfig = { findMany: vi.fn(async () => []) };
    stub.listing = { findMany: vi.fn(async () => []) };
    stub.party = { findFirst: vi.fn(async () => ({ displayName: "Test Owner" })) };
  });

  it("(m) receiptNo prefix is sourced from the org's IVOWN DocumentSeries.prefix, not hardcoded", async () => {
    const { getDb: mockGetDb } = await import("@kason/db");
    const stub = mockGetDb() as never as Record<string, object>;
    stub.documentSeries = { findFirst: vi.fn(async () => ({ prefix: "ZZZOWN" })) };

    const model = await buildOwnerLedgerReceiptModel(ivOwnCtx, "owner-1", "2026-07", null);
    expect(model).not.toBeNull();
    expect(model!.header.receiptNo).toMatch(/^ZZZOWN-202607-/);
  });

  it("(n) falls back to literal IVOWN when the org has no IVOWN DocumentSeries row", async () => {
    const { getDb: mockGetDb } = await import("@kason/db");
    const stub = mockGetDb() as never as Record<string, object>;
    stub.documentSeries = { findFirst: vi.fn(async () => null) };

    const model = await buildOwnerLedgerReceiptModel(ivOwnCtx, "owner-1", "2026-07", null);
    expect(model).not.toBeNull();
    expect(model!.header.receiptNo).toMatch(/^IVOWN-202607-/);
  });

  it('(o) documentSeries lookup is scoped to ctx.orgId + code="IVOWN" — never IVTEN or another org (proven via differential mock output)', async () => {
    const { getDb: mockGetDb } = await import("@kason/db");
    const stub = mockGetDb() as never as Record<string, object>;
    // Differential mock: only returns the "RIGHT" prefix when the where
    // clause matches EXACTLY this org + code "IVOWN". Any other org id or
    // any other code (e.g. a scoping bug that reads "IVTEN" instead, or a
    // bug that drops the organizationId filter entirely) gets "WRONGOWN" —
    // proving correctness via observable output, not brittle call-arg pinning.
    stub.documentSeries = {
      findFirst: vi.fn(async ({ where }: { where: { organizationId: string; code: string } }) =>
        where.organizationId === ivOwnCtx.orgId && where.code === "IVOWN"
          ? { prefix: "RIGHTOWN" }
          : { prefix: "WRONGOWN" },
      ),
    };

    const model = await buildOwnerLedgerReceiptModel(ivOwnCtx, "owner-1", "2026-07", null);
    expect(model).not.toBeNull();
    expect(model!.header.receiptNo).toMatch(/^RIGHTOWN-/);
    expect(model!.header.receiptNo).not.toMatch(/^WRONGOWN-/);
  });

  it("(p) falls back to literal IVOWN when the series row's prefix is an empty string", async () => {
    const { getDb: mockGetDb } = await import("@kason/db");
    const stub = mockGetDb() as never as Record<string, object>;
    stub.documentSeries = { findFirst: vi.fn(async () => ({ prefix: "" })) };

    const model = await buildOwnerLedgerReceiptModel(ivOwnCtx, "owner-1", "2026-07", null);
    expect(model).not.toBeNull();
    expect(model!.header.receiptNo).toMatch(/^IVOWN-202607-/);
  });
});
