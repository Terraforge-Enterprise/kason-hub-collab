/**
 * P4 Task 3: getOrgUnitsSummaryService — integration (real local Postgres).
 * Verifies: pagination/base-set, q filter, figures parity with
 * resolveOwnerPayoutForScope, occupancy, openDocuments, and the per-property
 * "Unassigned" residual row. Opt-in via RUN_INTEGRATION=1. Fixed UUIDs prefix f7.
 *
 * Task 8: recomputeUnitMonthLedgerService — manual recompute escape hatch.
 * Fixed UUIDs prefix ac.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";
import { getOrgUnitsSummaryService, recomputeUnitMonthLedgerService } from "../owner-ledger.service";
import { resolveOwnerPayoutForScope } from "../owner-payout-scope.service";
import { materializeOwnerUnitMonths } from "../unit-month-ledger.materialize";
import { centsToString } from "@kason/shared";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG       = "f7000000-0000-4000-8000-000000000001";
const USER      = "f7000000-0000-4000-8000-000000000002";
const PARTY_OP  = "f7000000-0000-4000-8000-000000000003";
const OWNER     = "f7000000-0000-4000-8000-000000000004";
const TENANT    = "f7000000-0000-4000-8000-000000000005";
const PROPERTY  = "f7000000-0000-4000-8000-000000000006";
const APT_A     = "f7000000-0000-4000-8000-0000000000a1"; // A-07-01 — has data
const APT_B     = "f7000000-0000-4000-8000-0000000000b1"; // A-07-02 — no data
const LISTING_A = "f7000000-0000-4000-8000-0000000000a2";
const LISTING_B = "f7000000-0000-4000-8000-0000000000b2";
const TENANCY_A = "f7000000-0000-4000-8000-0000000000a3";
const SERIES    = "f7000000-0000-4000-8000-0000000000d1";
const DOC       = "f7000000-0000-4000-8000-0000000000d2";

const MONTH_DATE  = "2025-09-01";
const MONTH_KEY   = "2025-09";
const MONTH_START = new Date(Date.UTC(2025, 8, 1));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocument.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
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

dn("getOrgUnitsSummaryService (P4)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG, name: "Org Units Org", slug: "org-units-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: PARTY_OP, organizationId: ORG, displayName: "Org Op", partyType: "individual", status: "active" } });
    await db.user.create({ data: { id: USER, organizationId: ORG, email: "org-units-op@example.com", fullName: "Org Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP } });
    await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Org Owner", partyType: "individual", status: "active" } });
    await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Org Tenant", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY, organizationId: ORG, name: "Org Residences",
        propertyCode: "OR1", propertyType: "apartment",
        addressLine1: "7 Org St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-07-01", listingMode: "WHOLE" } });
    await db.apartment.create({ data: { id: APT_B, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-07-02", listingMode: "WHOLE" } });
    await db.listing.create({ data: { id: LISTING_A, organizationId: ORG, apartmentId: APT_A, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
    await db.listing.create({ data: { id: LISTING_B, organizationId: ORG, apartmentId: APT_B, listingType: "unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
    await db.tenancy.create({ data: { id: TENANCY_A, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_A, tenantPartyId: TENANT, tenancyCode: "OR-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "1000.00" } });

    // Ledger rows: APT_A income 1000 + deductible expense 100; property-level
    // (null apartment) deductible expense 50 → the "Unassigned" residual row.
    const base = {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: PROPERTY,
      statementMonth: MONTH_START, transactionDate: new Date(Date.UTC(2025, 8, 15)),
      paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable",
      status: "active", createdById: USER, updatedById: USER, sstAmount: null,
    };
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT_A, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT_A, direction: "expense", category: "cleaning", amount: "100.00", includeInPayout: true } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: null, direction: "expense", category: "fire_insurance", amount: "50.00", includeInPayout: true } });

    // One OPEN BillingDocument on APT_A for this month (Plan 1 tables).
    await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP" } });
    await db.billingDocument.create({
      data: {
        id: DOC, organizationId: ORG, docType: "debit_note",
        documentNumber: "DEP-9701", seriesId: SERIES, status: "issued",
        issuedById: USER, billingMonth: MONTH_START,
        counterpartyType: "tenant", partyId: TENANT,
        apartmentId: APT_A, propertyId: PROPERTY,
        subtotal: "1000.00", sstAmount: "0.00", total: "1000.00",
      },
    });
  });

  afterAll(cleanup);

  it("returns both apartments (base set includes no-data units) with total=2, sorted by unitCode", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(2);
    const real = res.data.items.filter((r) => r.apartmentId != null);
    expect(real.map((r) => r.unitCode)).toEqual(["A-07-01", "A-07-02"]);
  });

  it("figures for A-07-01 equal resolveOwnerPayoutForScope (the one payout engine)", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rowA = res.data.items.find((r) => r.apartmentId === APT_A)!;
    const breakdown = (await resolveOwnerPayoutForScope(ctx, OWNER, MONTH_KEY, APT_A))!;
    expect(rowA.figures.income).toBe(centsToString(breakdown.grossRentalC));
    expect(rowA.figures.expenses).toBe(centsToString(breakdown.deductibleExpensesC));
    expect(rowA.figures.netPayout).toBe(centsToString(breakdown.totalPayoutC));
    expect(rowA.ownerName).toBe("Org Owner");
    expect(rowA.occupancy.activeTenancies).toBe(1);
    expect(rowA.openDocuments).toBe(1);
  });

  it("a no-data unit shows zero figures, its owner, zero open docs", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rowB = res.data.items.find((r) => r.apartmentId === APT_B)!;
    expect(rowB.figures).toEqual({ income: "0.00", expenses: "0.00", netPayout: "0.00" });
    expect(rowB.ownerPartyId).toBe(OWNER);
    expect(rowB.openDocuments).toBe(0);
    expect(rowB.occupancy.activeTenancies).toBe(0);
  });

  it("appends the per-property Unassigned residual row (apartmentId null) without counting it in total", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const residual = res.data.items.find((r) => r.apartmentId === null)!;
    expect(residual).toBeTruthy();
    expect(residual.unitCode).toBeNull();
    expect(residual.propertyId).toBe(PROPERTY);
    expect(residual.figures).toEqual({ income: "0.00", expenses: "50.00", netPayout: "-50.00" });
    expect(res.data.total).toBe(2); // residual excluded from total
  });

  it("q filters on unitCode (server-side contains)", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, q: "07-02", page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(1);
    expect(res.data.items.filter((r) => r.apartmentId != null)).toHaveLength(1);
    expect(res.data.items[0]!.unitCode).toBe("A-07-02");
  });

  it("paginates (pageSize=1 → page 2 holds the second unit)", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: MONTH_DATE, page: 2, pageSize: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(2);
    const real = res.data.items.filter((r) => r.apartmentId != null);
    expect(real).toHaveLength(1);
    expect(real[0]!.unitCode).toBe("A-07-02");
  });

  it("400s a YYYY-MM month", async () => {
    const res = await getOrgUnitsSummaryService(ctx, { month: "2025-09", page: 1, pageSize: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

/** Parse a money string like "1234.56" → cents integer. */
function strToCents(s: string): number {
  return Math.round(parseFloat(s) * 100);
}

// ─── Finding 1 regression: NULL-apartment INCOME row (the divergent case) ────
//
// The pre-fix residual re-derived netPayout as raw `incomeC − payoutExpenseC`
// straight off the OwnerLedgerEntry rows, bypassing `computeOwnerPayout`
// entirely. Two bugs that formula hid:
//   (a) a NULL-apartment INCOME row bears NO management fee/SST in the
//       residual, even when the row's category is fee-bearing — overstating
//       residual netPayout by exactly the fee that should have been deducted.
//   (b) residual `expenses` summed ALL expense rows (GROSS), while the unit
//       rows' `expenses` is DEDUCTIBLE-ONLY (`includeInPayout` rows only) —
//       same JSON field, two different meanings.
// This fixture triggers BOTH: a fee-bearing NULL-apartment income row PLUS a
// non-deductible (includeInPayout:false) NULL-apartment expense row. Fixed
// UUIDs prefix f9 (own org, disjoint from the f7 block above).
const ORG_F9      = "f9000000-0000-4000-8000-000000000001";
const USER_F9     = "f9000000-0000-4000-8000-000000000002";
const PARTY_OP_F9 = "f9000000-0000-4000-8000-000000000003";
const OWNER_F9    = "f9000000-0000-4000-8000-000000000004";
const TENANT_F9   = "f9000000-0000-4000-8000-000000000005";
const PROPERTY_F9 = "f9000000-0000-4000-8000-000000000006";
const APT_F9      = "f9000000-0000-4000-8000-0000000000a1"; // F9-01 — has data
const LISTING_F9  = "f9000000-0000-4000-8000-0000000000a2";

const ctxF9: OwnerBillingActorCtx = { orgId: ORG_F9, actorUserId: USER_F9, actorRole: "admin" };

async function cleanupF9() {
  const db = getDb();
  const org = { organizationId: ORG_F9 };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER_F9 } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG_F9 } });
}

dn("getOrgUnitsSummaryService — residual foots with combined (Finding 1)", () => {
  beforeAll(async () => {
    await cleanupF9();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG_F9, name: "Footing Org", slug: "footing-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: PARTY_OP_F9, organizationId: ORG_F9, displayName: "Footing Op", partyType: "individual", status: "active" } });
    await db.user.create({ data: { id: USER_F9, organizationId: ORG_F9, email: "footing-op@example.com", fullName: "Footing Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP_F9 } });
    await db.party.create({ data: { id: OWNER_F9, organizationId: ORG_F9, displayName: "Footing Owner", partyType: "individual", status: "active" } });
    await db.party.create({ data: { id: TENANT_F9, organizationId: ORG_F9, displayName: "Footing Tenant", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY_F9, organizationId: ORG_F9, name: "Footing Residences",
        propertyCode: "FT1", propertyType: "apartment",
        addressLine1: "9 Footing St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT_F9, organizationId: ORG_F9, propertyId: PROPERTY_F9, unitCode: "F9-01", listingMode: "WHOLE" } });
    await db.listing.create({ data: { id: LISTING_F9, organizationId: ORG_F9, apartmentId: APT_F9, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_F9 } });

    // 10% mgmt fee + 8% SST, all-properties (no per-property override).
    await db.managementFeeConfig.create({
      data: {
        organizationId: ORG_F9, ownerPartyId: OWNER_F9, propertyId: null,
        feeType: "percent", feeValue: "10.00", capAmount: null,
        sstPercent: "8.00", isActive: true,
      },
    });

    const base = {
      organizationId: ORG_F9, ownerPartyId: OWNER_F9, propertyId: PROPERTY_F9,
      statementMonth: MONTH_START, transactionDate: new Date(Date.UTC(2025, 8, 15)),
      paymentStatus: "paid", taxCategory: "not_applicable",
      status: "active", createdById: USER_F9, updatedById: USER_F9, sstAmount: null,
    };
    // Apartment-scoped: income 1000 (fee-bearing) + expense 100 (deductible).
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT_F9, direction: "income", category: "rental_income", amount: "1000.00", paidBy: "tenant", includeInPayout: true } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT_F9, direction: "expense", category: "maintenance", amount: "100.00", paidBy: "owner", includeInPayout: true } });
    // NULL-apartment (property-level) — THE DIVERGENT CASE:
    //   income 500 (fee-bearing rental_income) — pre-fix, this bears NO fee.
    //   expense 50 (deductible, fire_insurance).
    //   expense 30 (NON-deductible, owner-paid) — pre-fix, this leaks into
    //     the GROSS `expenses` figure even though it is not deductible.
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: null, direction: "income", category: "rental_income", amount: "500.00", paidBy: "tenant", includeInPayout: true } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: null, direction: "expense", category: "fire_insurance", amount: "50.00", paidBy: "kaen", includeInPayout: true } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: null, direction: "expense", category: "cleaning", amount: "30.00", paidBy: "owner", includeInPayout: false } });
  });

  afterAll(cleanupF9);

  it("Σ(unit figures) + Σ(residual figures) === resolveOwnerPayoutForScope combined, field-by-field", async () => {
    const res = await getOrgUnitsSummaryService(ctxF9, { month: MONTH_DATE, page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const ownerRows = res.data.items.filter((r) => r.ownerPartyId === OWNER_F9);
    // Exactly one unit row (APT_F9) + exactly one residual row for this owner.
    expect(ownerRows.filter((r) => r.apartmentId != null)).toHaveLength(1);
    const residualRows = ownerRows.filter((r) => r.apartmentId === null);
    expect(residualRows).toHaveLength(1);
    expect(residualRows[0]!.propertyId).toBe(PROPERTY_F9);

    const sumIncomeC   = ownerRows.reduce((acc, r) => acc + strToCents(r.figures.income), 0);
    const sumExpensesC = ownerRows.reduce((acc, r) => acc + strToCents(r.figures.expenses), 0);
    const sumNetC      = ownerRows.reduce((acc, r) => acc + strToCents(r.figures.netPayout), 0);

    const combined = (await resolveOwnerPayoutForScope(ctxF9, OWNER_F9, MONTH_KEY, null))!;
    expect(combined).toBeTruthy();
    expect(sumIncomeC).toBe(combined.grossRentalC);
    expect(sumExpensesC).toBe(combined.deductibleExpensesC);
    expect(sumNetC).toBe(combined.totalPayoutC);

    // Sanity: the residual is neither zero nor a naive incomeC−expenseC
    // readout (500.00 − 50.00 = 450.00) — the mgmt fee/SST on the NULL-apartment
    // income row must be deducted, and the non-deductible expense excluded.
    expect(residualRows[0]!.figures.netPayout).not.toBe("450.00");
  });
});

// ─── Finding 2 + 3 regression: stable pagination + no repeated residual ──────
//
// One property with THREE apartments (more than one page at pageSize=2) plus
// a NULL-apartment ledger row for that property/owner. Apartments are
// ordered [property.name asc, unitCode asc, id asc] (Finding 2's tiebreaker),
// so this property's 3 apartments are contiguous: page 1 holds apartments
// #1–2, page 2 holds apartment #3. Finding 3: the residual row must appear
// EXACTLY ONCE — on page 1, the page containing the property's FIRST
// apartment — never repeated on page 2. Fixed UUIDs prefix fb.
const ORG_FB      = "fb000000-0000-4000-8000-000000000001";
const USER_FB     = "fb000000-0000-4000-8000-000000000002";
const PARTY_OP_FB = "fb000000-0000-4000-8000-000000000003";
const OWNER_FB    = "fb000000-0000-4000-8000-000000000004";
const PROPERTY_FB = "fb000000-0000-4000-8000-000000000006";
const APT_FB_1    = "fb000000-0000-4000-8000-0000000000a1"; // FB-01
const APT_FB_2    = "fb000000-0000-4000-8000-0000000000a2"; // FB-02
const APT_FB_3    = "fb000000-0000-4000-8000-0000000000a3"; // FB-03

const ctxFB: OwnerBillingActorCtx = { orgId: ORG_FB, actorUserId: USER_FB, actorRole: "admin" };

async function cleanupFB() {
  const db = getDb();
  const org = { organizationId: ORG_FB };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER_FB } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG_FB } });
}

dn("getOrgUnitsSummaryService — residual pagination boundary (Finding 2+3)", () => {
  beforeAll(async () => {
    await cleanupFB();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG_FB, name: "Boundary Org", slug: "boundary-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: PARTY_OP_FB, organizationId: ORG_FB, displayName: "Boundary Op", partyType: "individual", status: "active" } });
    await db.user.create({ data: { id: USER_FB, organizationId: ORG_FB, email: "boundary-op@example.com", fullName: "Boundary Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP_FB } });
    await db.party.create({ data: { id: OWNER_FB, organizationId: ORG_FB, displayName: "Boundary Owner", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY_FB, organizationId: ORG_FB, name: "Boundary Residences",
        propertyCode: "BD1", propertyType: "apartment",
        addressLine1: "11 Boundary St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    await db.apartment.create({ data: { id: APT_FB_1, organizationId: ORG_FB, propertyId: PROPERTY_FB, unitCode: "FB-01", listingMode: "WHOLE" } });
    await db.apartment.create({ data: { id: APT_FB_2, organizationId: ORG_FB, propertyId: PROPERTY_FB, unitCode: "FB-02", listingMode: "WHOLE" } });
    await db.apartment.create({ data: { id: APT_FB_3, organizationId: ORG_FB, propertyId: PROPERTY_FB, unitCode: "FB-03", listingMode: "WHOLE" } });

    // One NULL-apartment (property-level) expense row → the residual row.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG_FB, ownerPartyId: OWNER_FB, propertyId: PROPERTY_FB,
        apartmentId: null, statementMonth: MONTH_START,
        transactionDate: new Date(Date.UTC(2025, 8, 15)),
        direction: "expense", category: "fire_insurance", amount: "50.00", sstAmount: null,
        paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable",
        includeInPayout: true, status: "active", createdById: USER_FB, updatedById: USER_FB,
      },
    });
  });

  afterAll(cleanupFB);

  it("residual appears exactly once, on the first page its property occurs (page 1 of 2)", async () => {
    const page1 = await getOrgUnitsSummaryService(ctxFB, { month: MONTH_DATE, page: 1, pageSize: 2 });
    const page2 = await getOrgUnitsSummaryService(ctxFB, { month: MONTH_DATE, page: 2, pageSize: 2 });
    expect(page1.ok).toBe(true);
    expect(page2.ok).toBe(true);
    if (!page1.ok || !page2.ok) return;

    // Stable, deterministic global order (Finding 2): page 1 = FB-01, FB-02;
    // page 2 = FB-03 — the property's block spans the page boundary.
    const page1Units = page1.data.items.filter((r) => r.apartmentId != null).map((r) => r.unitCode);
    const page2Units = page2.data.items.filter((r) => r.apartmentId != null).map((r) => r.unitCode);
    expect(page1Units).toEqual(["FB-01", "FB-02"]);
    expect(page2Units).toEqual(["FB-03"]);

    const page1Residuals = page1.data.items.filter((r) => r.apartmentId === null && r.propertyId === PROPERTY_FB);
    const page2Residuals = page2.data.items.filter((r) => r.apartmentId === null && r.propertyId === PROPERTY_FB);
    expect(page1Residuals).toHaveLength(1); // shown on the page holding the property's FIRST apartment
    expect(page2Residuals).toHaveLength(0); // NOT repeated on the page holding its LAST apartment
  });
});

// ─── Task 5: flag-gated materialized read (UnitMonthLedger) ──────────────────
//
// 2 owned apartments (APT1_FE, APT2_FE owned by OWNER_FE) + 1 unowned
// (APT_UNOWNED_FE — no listing). Ledger rows for APT1_FE only (income 2000,
// deductible expense 200). Month "2025-08".
//
// flag ON path: materialize first, then getOrgUnitsSummaryService reads
//   UnitMonthLedger rows instead of calling resolveOwnerPayoutForScope per
//   apartment — figures must be cent-for-cent identical to the live engine.
// flag OFF path: legacy live path still works (res.ok === true).
// Fixed UUIDs prefix fe.

const ORG_FE         = "fe000000-0000-4000-8000-000000000001";
const USER_FE        = "fe000000-0000-4000-8000-000000000002";
const PARTY_OP_FE    = "fe000000-0000-4000-8000-000000000003";
const OWNER_FE       = "fe000000-0000-4000-8000-000000000004";
const TENANT_FE      = "fe000000-0000-4000-8000-000000000005";
const PROPERTY_FE    = "fe000000-0000-4000-8000-000000000006";
const APT1_FE        = "fe000000-0000-4000-8000-0000000000a1";
const APT2_FE        = "fe000000-0000-4000-8000-0000000000a2";
const APT_UNOWNED_FE = "fe000000-0000-4000-8000-0000000000a3";
const LISTING1_FE    = "fe000000-0000-4000-8000-0000000000b1";
const LISTING2_FE    = "fe000000-0000-4000-8000-0000000000b2";

const MONTH_START_FE = new Date(Date.UTC(2025, 7, 1)); // 2025-08-01
const MONTH_KEY_FE   = "2025-08";

const ctxFE: OwnerBillingActorCtx = { orgId: ORG_FE, actorUserId: USER_FE, actorRole: "admin" };

async function cleanupFE() {
  const db = getDb();
  const org = { organizationId: ORG_FE };
  await db.unitMonthLedger.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER_FE } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG_FE } });
}

dn("getOrgUnitsSummaryService — flag-gated materialized read (Task 5)", () => {
  beforeAll(async () => {
    await cleanupFE();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG_FE, name: "FE Org", slug: "fe-org",
        status: "active", defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.party.create({ data: { id: PARTY_OP_FE, organizationId: ORG_FE, displayName: "FE Op", partyType: "individual", status: "active" } });
    await db.user.create({ data: { id: USER_FE, organizationId: ORG_FE, email: "fe-op@example.com", fullName: "FE Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP_FE } });
    await db.party.create({ data: { id: OWNER_FE, organizationId: ORG_FE, displayName: "FE Owner", partyType: "individual", status: "active" } });
    await db.party.create({ data: { id: TENANT_FE, organizationId: ORG_FE, displayName: "FE Tenant", partyType: "individual", status: "active" } });
    await db.property.create({
      data: {
        id: PROPERTY_FE, organizationId: ORG_FE, name: "FE Residences",
        propertyCode: "FE1", propertyType: "apartment",
        addressLine1: "1 FE St", city: "KL", country: "MY",
        status: "active", publishStatus: "draft",
      },
    });
    // 2 owned apartments
    await db.apartment.create({ data: { id: APT1_FE, organizationId: ORG_FE, propertyId: PROPERTY_FE, unitCode: "FE-01", listingMode: "WHOLE" } });
    await db.apartment.create({ data: { id: APT2_FE, organizationId: ORG_FE, propertyId: PROPERTY_FE, unitCode: "FE-02", listingMode: "WHOLE" } });
    // 1 unowned apartment (no listing → ownerByApt will have no entry for it)
    await db.apartment.create({ data: { id: APT_UNOWNED_FE, organizationId: ORG_FE, propertyId: PROPERTY_FE, unitCode: "FE-03", listingMode: "WHOLE" } });
    // Listings for APT1 and APT2 (owned by OWNER_FE)
    await db.listing.create({ data: { id: LISTING1_FE, organizationId: ORG_FE, apartmentId: APT1_FE, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_FE } });
    await db.listing.create({ data: { id: LISTING2_FE, organizationId: ORG_FE, apartmentId: APT2_FE, listingType: "unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_FE } });
    // Ledger entries for APT1_FE only: income 2000 + deductible expense 200
    const base = {
      organizationId: ORG_FE, ownerPartyId: OWNER_FE, propertyId: PROPERTY_FE,
      statementMonth: MONTH_START_FE, transactionDate: new Date(Date.UTC(2025, 7, 15)),
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "not_applicable",
      status: "active", createdById: USER_FE, updatedById: USER_FE, sstAmount: null,
    };
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT1_FE, direction: "income", category: "rental_income", amount: "2000.00", includeInPayout: true } });
    await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT1_FE, direction: "expense", category: "maintenance", amount: "200.00", includeInPayout: true } });
  });

  afterAll(cleanupFE);

  it("flag ON: returns same figures as live compute, reading materialized rows", async () => {
    const prevOwnerBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    const prevUnitLedger   = process.env.ENABLE_UNIT_MONTH_LEDGER;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "true";
    process.env.ENABLE_UNIT_MONTH_LEDGER    = "true";
    try {
      // Materialize first so the flag-ON path has rows to read.
      await materializeOwnerUnitMonths(ctxFE, OWNER_FE, MONTH_KEY_FE);

      const res = await getOrgUnitsSummaryService(ctxFE, { month: "2025-08-01", page: 1, pageSize: 20 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // APT1_FE: figures must match the live resolveOwnerPayoutForScope engine.
      const apt1Row = res.data.items.find((r) => r.apartmentId === APT1_FE)!;
      expect(apt1Row).toBeTruthy();
      const live = (await resolveOwnerPayoutForScope(ctxFE, OWNER_FE, MONTH_KEY_FE, APT1_FE))!;
      expect(apt1Row.figures.income).toBe(centsToString(live.grossRentalC));
      expect(apt1Row.figures.expenses).toBe(centsToString(live.deductibleExpensesC));
      expect(apt1Row.figures.netPayout).toBe(centsToString(live.totalPayoutC));

      // I3 — APT_UNOWNED_FE: no listing → ownerByApt has no entry → zero figures (unconditional).
      const unownedRow = res.data.items.find((r) => r.apartmentId === APT_UNOWNED_FE)!;
      expect(unownedRow.figures).toEqual({ income: "0.00", expenses: "0.00", netPayout: "0.00" });

      // I1 — Poison the cache to prove the flag-ON read serves from UnitMonthLedger,
      // not from a fresh live compute (which would produce ~"2000.00", not "7777.00").
      // The far-future sourceMaxUpdatedAt ensures the monotonic guard blocks any
      // re-materialize from overwriting the poison.
      const dbPoison = getDb();
      await dbPoison.unitMonthLedger.upsert({
        where: { organizationId_apartmentId_periodMonth: { organizationId: ORG_FE, apartmentId: APT1_FE, periodMonth: MONTH_START_FE } },
        create: {
          organizationId: ORG_FE, apartmentId: APT1_FE, periodMonth: MONTH_START_FE,
          ownerPartyId: OWNER_FE, incomeC: 777700, deductibleExpensesC: 0, netPayoutC: 0,
          mgmtFeeC: 0, sstC: 0, sourceMaxUpdatedAt: new Date("2099-01-01"),
        },
        update: {
          incomeC: 777700, sourceMaxUpdatedAt: new Date("2099-01-01"),
        },
      });
      const resPoison = await getOrgUnitsSummaryService(ctxFE, { month: "2025-08-01", page: 1, pageSize: 20 });
      expect(resPoison.ok).toBe(true);
      if (!resPoison.ok) return;
      const apt1PoisonRow = resPoison.data.items.find((r) => r.apartmentId === APT1_FE)!;
      expect(apt1PoisonRow.figures.income).toBe("7777.00"); // proves read is from UnitMonthLedger
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = prevOwnerBilling ?? "";
      process.env.ENABLE_UNIT_MONTH_LEDGER    = prevUnitLedger ?? "";
    }
  });

  it("flag ON + no pre-materialize: lazy fallback materializes and serves correct figures", async () => {
    // I2 — Verify the CRITICAL lazy-fallback branch: APT1_FE has ledger entries but
    // no pre-materialized row. With both flags ON, getOrgUnitsSummaryService must
    // trigger syncOwnerLedgerForOwnerMonth (lazy fallback), materialize APT1_FE, and
    // serve correct figures — proving this branch has coverage.
    const prevOwnerBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    const prevUnitLedger   = process.env.ENABLE_UNIT_MONTH_LEDGER;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "true";
    process.env.ENABLE_UNIT_MONTH_LEDGER    = "true";
    const dbFallback = getDb();
    try {
      // Ensure no pre-materialized rows so the lazy fallback must trigger.
      await dbFallback.unitMonthLedger.deleteMany({ where: { organizationId: ORG_FE, periodMonth: MONTH_START_FE } });

      const res = await getOrgUnitsSummaryService(ctxFE, { month: "2025-08-01", page: 1, pageSize: 20 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // APT1_FE: figures must match the live engine (income 2000, expense 200, net 1800, no fee config).
      const apt1Row = res.data.items.find((r) => r.apartmentId === APT1_FE)!;
      expect(apt1Row).toBeTruthy();
      const live = (await resolveOwnerPayoutForScope(ctxFE, OWNER_FE, MONTH_KEY_FE, APT1_FE))!;
      expect(apt1Row.figures.income).toBe(centsToString(live.grossRentalC));
      expect(apt1Row.figures.expenses).toBe(centsToString(live.deductibleExpensesC));
      expect(apt1Row.figures.netPayout).toBe(centsToString(live.totalPayoutC));

      // Prove the lazy fallback materialized: a UnitMonthLedger row for APT1_FE must now exist.
      const materializedRow = await dbFallback.unitMonthLedger.findUnique({
        where: { organizationId_apartmentId_periodMonth: { organizationId: ORG_FE, apartmentId: APT1_FE, periodMonth: MONTH_START_FE } },
      });
      expect(materializedRow).toBeTruthy();
      expect(materializedRow!.incomeC).toBe(live.grossRentalC);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = prevOwnerBilling ?? "";
      process.env.ENABLE_UNIT_MONTH_LEDGER    = prevUnitLedger ?? "";
    }
  });

  it("flag OFF: identical output via legacy live path, with figure assertions", async () => {
    // M1 — Self-contained flag-OFF test: verifies figures via legacy live path, not just res.ok.
    const prevUnitLedger = process.env.ENABLE_UNIT_MONTH_LEDGER;
    process.env.ENABLE_UNIT_MONTH_LEDGER = "";
    try {
      const res = await getOrgUnitsSummaryService(ctxFE, { month: "2025-08-01", page: 1, pageSize: 20 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const apt1Row = res.data.items.find((r) => r.apartmentId === APT1_FE)!;
      expect(apt1Row).toBeTruthy();
      const live = (await resolveOwnerPayoutForScope(ctxFE, OWNER_FE, MONTH_KEY_FE, APT1_FE))!;
      expect(apt1Row.figures.income).toBe(centsToString(live.grossRentalC));
      expect(apt1Row.figures.expenses).toBe(centsToString(live.deductibleExpensesC));
      expect(apt1Row.figures.netPayout).toBe(centsToString(live.totalPayoutC));
    } finally {
      process.env.ENABLE_UNIT_MONTH_LEDGER = prevUnitLedger ?? "";
    }
  });
});

// ─── Task 8: recomputeUnitMonthLedgerService — manual escape hatch ───────────
//
// 2 owned apartments (APT1_RC, APT2_RC both owned by OWNER_RC), each with a
// ledger entry. Verifies that after deleting materialized rows,
// recomputeUnitMonthLedgerService re-populates UnitMonthLedger for the owner.
// Fixed UUIDs prefix ac.

const ORG_RC      = "ac000000-0000-4000-8000-000000000001";
const USER_RC     = "ac000000-0000-4000-8000-000000000002";
const PARTY_OP_RC = "ac000000-0000-4000-8000-000000000003";
const OWNER_RC    = "ac000000-0000-4000-8000-000000000004";
const PROPERTY_RC = "ac000000-0000-4000-8000-000000000006";
const APT1_RC     = "ac000000-0000-4000-8000-0000000000a1";
const APT2_RC     = "ac000000-0000-4000-8000-0000000000a2";
const LISTING1_RC = "ac000000-0000-4000-8000-0000000000b1";
const LISTING2_RC = "ac000000-0000-4000-8000-0000000000b2";

const MONTH_START_RC = new Date(Date.UTC(2025, 6, 1)); // 2025-07-01
const MONTH_KEY_RC   = "2025-07";

const ctxRC: OwnerBillingActorCtx = { orgId: ORG_RC, actorUserId: USER_RC, actorRole: "admin" };

async function cleanupRC() {
  const db = getDb();
  const org = { organizationId: ORG_RC };
  await db.unitMonthLedger.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER_RC } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG_RC } });
}

async function seedRC() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG_RC, name: "RC Org", slug: "rc-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY_OP_RC, organizationId: ORG_RC, displayName: "RC Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER_RC, organizationId: ORG_RC, email: "rc-op@example.com", fullName: "RC Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP_RC } });
  await db.party.create({ data: { id: OWNER_RC, organizationId: ORG_RC, displayName: "RC Owner", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: PROPERTY_RC, organizationId: ORG_RC, name: "RC Residences",
      propertyCode: "RC1", propertyType: "apartment",
      addressLine1: "1 RC St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({ data: { id: APT1_RC, organizationId: ORG_RC, propertyId: PROPERTY_RC, unitCode: "RC-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT2_RC, organizationId: ORG_RC, propertyId: PROPERTY_RC, unitCode: "RC-02", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING1_RC, organizationId: ORG_RC, apartmentId: APT1_RC, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_RC } });
  await db.listing.create({ data: { id: LISTING2_RC, organizationId: ORG_RC, apartmentId: APT2_RC, listingType: "unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_RC } });
  const base = {
    organizationId: ORG_RC, ownerPartyId: OWNER_RC, propertyId: PROPERTY_RC,
    statementMonth: MONTH_START_RC, transactionDate: new Date(Date.UTC(2025, 6, 15)),
    paidBy: "tenant", paymentStatus: "paid", taxCategory: "not_applicable",
    status: "active", createdById: USER_RC, updatedById: USER_RC, sstAmount: null,
  };
  await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT1_RC, direction: "income", category: "rental_income", amount: "1500.00", includeInPayout: true } });
  await db.ownerLedgerEntry.create({ data: { ...base, apartmentId: APT2_RC, direction: "income", category: "rental_income", amount: "1200.00", includeInPayout: true } });
}

dn("recomputeUnitMonthLedgerService (Task 8)", () => {
  beforeAll(async () => {
    await cleanupRC();
    await seedRC();
  });
  afterAll(cleanupRC);

  it("manual recompute repopulates rows for the month", async () => {
    const db = getDb();
    // Wipe any pre-existing materialized rows to simulate stale/missing cache.
    await db.unitMonthLedger.deleteMany({ where: { organizationId: ORG_RC } });
    const r = await recomputeUnitMonthLedgerService(ctxRC, { month: MONTH_KEY_RC, ownerPartyId: OWNER_RC });
    expect(r.ok).toBe(true);
    const rows = await db.unitMonthLedger.findMany({ where: { organizationId: ORG_RC, periodMonth: MONTH_START_RC } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
