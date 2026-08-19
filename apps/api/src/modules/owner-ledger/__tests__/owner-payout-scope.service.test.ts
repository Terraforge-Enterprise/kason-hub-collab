/**
 * Task 1: resolveOwnerPayoutForScope — integration test (RED → GREEN).
 *
 * Verifies:
 *   1. footing: grossCashInC − deductibleExpensesC === totalPayoutC
 *   2. equality: the helper's result matches running computeOwnerPayout
 *      directly on the same fetched inputs (same rows + same feeConfigRows
 *      + same depositCollectedC).
 *   3. empty scope → null (no active rows for owner/month).
 *   4. apartmentId=null → all apartments combined.
 *   5. apartmentId scoped → only that apartment's rows.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (2b..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import {
  computeOwnerPayout,
  findOwnerLedgerRowsForMonth,
} from "../../owner-billing/owner-statement-sections";
import { findDepositsCollectedInMonth, depositWindowEndOfMonth } from "../../owner-billing/owner-billing.repository";
import { toCents } from "@kason/shared";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

// Module under test — will NOT exist yet (RED phase).
import { resolveOwnerPayoutForScope } from "../owner-payout-scope.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed UUIDs — prefix 2b (unique to this test file) ──────────────────────
const ORG       = "2b000000-0000-4000-8000-000000000001";
const USER      = "2b000000-0000-4000-8000-000000000002";
const PARTY_OP  = "2b000000-0000-4000-8000-000000000003";
const OWNER     = "2b000000-0000-4000-8000-000000000004";
const TENANT    = "2b000000-0000-4000-8000-000000000005";
const PROPERTY  = "2b000000-0000-4000-8000-000000000006";
// Two apartments so we can test the scoped vs combined paths.
const APT_A     = "2b000000-0000-4000-8000-0000000000a1"; // Apartment A
const APT_B     = "2b000000-0000-4000-8000-0000000000b1"; // Apartment B
// One listing per apartment.
const LISTING_A  = "2b000000-0000-4000-8000-0000000000a2";
const LISTING_B  = "2b000000-0000-4000-8000-0000000000b2";
// Tenancies (required FK for Deposit).
const TENANCY_A  = "2b000000-0000-4000-8000-0000000000a3";
const TENANCY_B  = "2b000000-0000-4000-8000-0000000000b3";

const MONTH       = "2025-11";
const MONTH_START = new Date(Date.UTC(2025, 10, 1)); // 2025-11-01T00:00:00Z
const MID_MONTH   = new Date(Date.UTC(2025, 10, 15));

const ctx: OwnerBillingActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
};

// ─── Cleanup ─────────────────────────────────────────────────────────────────
async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

// ─── Seed ─────────────────────────────────────────────────────────────────────
async function seed() {
  const db = getDb();

  await db.organization.create({
    data: {
      id: ORG, name: "Scope Payout Org", slug: "scope-payout-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY_OP, organizationId: ORG, displayName: "Scope Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "scope-op@example.com", fullName: "Scope Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Scope Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Scope Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Scope Residences",
      propertyCode: "SR1", propertyType: "apartment",
      addressLine1: "1 Scope St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });

  // Two apartments with one listing each.
  await db.apartment.create({ data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-01-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_B, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-01-02", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING_A, organizationId: ORG, apartmentId: APT_A, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.listing.create({ data: { id: LISTING_B, organizationId: ORG, apartmentId: APT_B, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  // Tenancies — required as FK for Deposit.
  await db.tenancy.create({ data: { id: TENANCY_A, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_A, tenantPartyId: TENANT, tenancyCode: "SR-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "1200.00" } });
  await db.tenancy.create({ data: { id: TENANCY_B, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_B, tenantPartyId: TENANT, tenancyCode: "SR-T2", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "800.00" } });

  // ManagementFeeConfig — 10% + 8% SST (all-properties, no override).
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });

  // OwnerLedgerEntry rows for Apt A in MONTH.
  // income: rental_income (1,200.00) — bears management fee
  // expense: maintenance (150.00, deductible) — not a management_fee or suppressed utility
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT_A, listingId: LISTING_A,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Nov rent A", amount: "1200.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT_A, listingId: LISTING_A,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "expense", category: "maintenance",
      description: "Nov maintenance A", amount: "150.00", sstAmount: null,
      paidBy: "owner", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // OwnerLedgerEntry rows for Apt B in MONTH.
  // income: rental_income (800.00) — bears management fee
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT_B, listingId: LISTING_B,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Nov rent B", amount: "800.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // Deposit for Apt A (collected in MONTH).
  await db.deposit.create({
    data: {
      organizationId: ORG,
      tenancyId: TENANCY_A,
      partyId: TENANT, unitId: LISTING_A,
      type: "security", amount: "2400.00",
      status: "held", createdAt: MID_MONTH,
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────
dn("resolveOwnerPayoutForScope", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("RED → GREEN: returns null when no active ledger rows for owner+month", async () => {
    await cleanup();
    await seed();
    // Use a month that has NO ledger rows.
    const result = await resolveOwnerPayoutForScope(ctx, OWNER, "2020-01", null);
    expect(result).toBeNull();
  });

  it("footing: grossCashInC − deductibleExpensesC === totalPayoutC (Apt A scoped)", async () => {
    await cleanup();
    await seed();

    const breakdown = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, APT_A);
    expect(breakdown).not.toBeNull();
    const b = breakdown!;
    expect(b.grossCashInC - b.deductibleExpensesC).toBe(b.totalPayoutC);
  });

  it("equality: result matches computeOwnerPayout run directly on same inputs (Apt A scoped)", async () => {
    await cleanup();
    await seed();

    // Fetch the same inputs manually to compare.
    const rows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, APT_A);
    expect(rows.length).toBeGreaterThan(0);

    const db = getDb();
    const feeConfigRows = await db.managementFeeConfig.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER, isActive: true },
      select: { propertyId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, updatedAt: true },
    });

    // Deposits scoped to Apt A listings only.
    const aptAListings = [LISTING_A];
    const monthEnd = depositWindowEndOfMonth(MONTH_START);
    const depositRowsA = await findDepositsCollectedInMonth(ORG, aptAListings, MONTH_START, monthEnd);
    const depositCollectedC = depositRowsA.reduce((acc, r) => acc + toCents(r.amount, "test"), 0);

    const expected = computeOwnerPayout({ rows, feeConfigRows, depositCollectedC });
    const actual = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, APT_A);

    expect(actual).not.toBeNull();
    expect(actual!.totalPayoutC).toBe(expected.totalPayoutC);
    expect(actual!.grossCashInC).toBe(expected.grossCashInC);
    expect(actual!.deductibleExpensesC).toBe(expected.deductibleExpensesC);
    expect(actual!.depositCollectedC).toBe(expected.depositCollectedC);
  });

  it("footing: grossCashInC − deductibleExpensesC === totalPayoutC (all apartments, null scope)", async () => {
    await cleanup();
    await seed();

    const breakdown = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, null);
    expect(breakdown).not.toBeNull();
    const b = breakdown!;
    expect(b.grossCashInC - b.deductibleExpensesC).toBe(b.totalPayoutC);
  });

  it("equality: combined (null) result matches computeOwnerPayout on all rows", async () => {
    await cleanup();
    await seed();

    const rows = await findOwnerLedgerRowsForMonth(ctx, OWNER, MONTH_START, null);
    expect(rows.length).toBeGreaterThan(0);

    const db = getDb();
    const feeConfigRows = await db.managementFeeConfig.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER, isActive: true },
      select: { propertyId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, updatedAt: true },
    });

    // All owner listings — only APT_A has a deposit in seed.
    const allListings = [LISTING_A, LISTING_B];
    const monthEnd = depositWindowEndOfMonth(MONTH_START);
    const depositRowsAll = await findDepositsCollectedInMonth(ORG, allListings, MONTH_START, monthEnd);
    const depositCollectedC = depositRowsAll.reduce((acc, r) => acc + toCents(r.amount, "test"), 0);

    const expected = computeOwnerPayout({ rows, feeConfigRows, depositCollectedC });
    const actual = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, null);

    expect(actual).not.toBeNull();
    expect(actual!.totalPayoutC).toBe(expected.totalPayoutC);
    expect(actual!.grossCashInC).toBe(expected.grossCashInC);
    expect(actual!.deductibleExpensesC).toBe(expected.deductibleExpensesC);
    expect(actual!.depositCollectedC).toBe(expected.depositCollectedC);
  });

  it("scoped Apt A net is less than combined net (Apt B has no deposit but adds income)", async () => {
    await cleanup();
    await seed();

    const aptA = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, APT_A);
    const combined = await resolveOwnerPayoutForScope(ctx, OWNER, MONTH, null);

    expect(aptA).not.toBeNull();
    expect(combined).not.toBeNull();
    // Apt A + Apt B income combined > Apt A alone.
    expect(combined!.grossRentalC).toBeGreaterThan(aptA!.grossRentalC);
  });
});
