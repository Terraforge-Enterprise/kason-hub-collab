/**
 * Task 5: getUnitsSummaryService — integration test (RED → GREEN).
 *
 * Verifies the CONVERGENCE guarantee:
 *   1. Each unit foots: incomeCollected + depositCollected − deductibleExpenses === netPayout (cents round-trip).
 *   2. Σ(units[].netPayout) === combined.netPayout.
 *   3. combined.netPayout === getOwnerMonthsService(ctx, ownerPartyId, null).<month>.netPayoutToOwner
 *      (the EXISTING per-month card number — the statement source of truth).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (5u..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

// Modules under test — getUnitsSummaryService will NOT exist yet (RED phase).
import { getUnitsSummaryService } from "../owner-ledger.service";
import { getOwnerMonthsService } from "../owner-ledger.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed UUIDs — prefix e5 (unique to this test file, all-hex) ─────────────
const ORG       = "f5000000-0000-4000-8000-000000000001";
const USER      = "f5000000-0000-4000-8000-000000000002";
const PARTY_OP  = "f5000000-0000-4000-8000-000000000003";
const OWNER     = "f5000000-0000-4000-8000-000000000004";
const TENANT    = "f5000000-0000-4000-8000-000000000005";
const PROPERTY  = "f5000000-0000-4000-8000-000000000006";
// Two apartments.
const APT_A     = "f5000000-0000-4000-8000-0000000000a1"; // A-05-01
const APT_B     = "f5000000-0000-4000-8000-0000000000b1"; // A-05-02
// One listing per apartment.
const LISTING_A = "f5000000-0000-4000-8000-0000000000a2";
const LISTING_B = "f5000000-0000-4000-8000-0000000000b2";
// Tenancies (required FK for Deposit).
const TENANCY_A = "f5000000-0000-4000-8000-0000000000a3";
const TENANCY_B = "f5000000-0000-4000-8000-0000000000b3";

const MONTH       = "2025-08";
const MONTH_START = new Date(Date.UTC(2025, 7, 1)); // 2025-08-01T00:00:00Z
const MID_MONTH   = new Date(Date.UTC(2025, 7, 15));

const ledgerCtx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

// getUnitsSummaryService expects OwnerBillingActorCtx
const billingCtx: OwnerBillingActorCtx = {
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
      id: ORG, name: "Units Summary Org", slug: "units-summary-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY_OP, organizationId: ORG, displayName: "Summary Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "summary-op@example.com", fullName: "Summary Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Summary Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Summary Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Summary Residences",
      propertyCode: "SU1", propertyType: "apartment",
      addressLine1: "5 Summary St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });

  // Two apartments with one listing each.
  await db.apartment.create({ data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-05-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT_B, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-05-02", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING_A, organizationId: ORG, apartmentId: APT_A, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.listing.create({ data: { id: LISTING_B, organizationId: ORG, apartmentId: APT_B, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  // Tenancies — required as FK for Deposit.
  await db.tenancy.create({ data: { id: TENANCY_A, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_A, tenantPartyId: TENANT, tenancyCode: "SU-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "1500.00" } });
  await db.tenancy.create({ data: { id: TENANCY_B, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING_B, tenantPartyId: TENANT, tenancyCode: "SU-T2", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "900.00" } });

  // ManagementFeeConfig — 10% + 8% SST (all-properties, no override).
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });

  // OwnerLedgerEntry rows for Apt A — income 1500, expense 200.
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT_A, listingId: LISTING_A,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent A", amount: "1500.00", sstAmount: null,
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
      description: "Aug maintenance A", amount: "200.00", sstAmount: null,
      paidBy: "owner", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // OwnerLedgerEntry rows for Apt B — income 900 only (no expense).
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT_B, listingId: LISTING_B,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent B", amount: "900.00", sstAmount: null,
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
      type: "security", amount: "3000.00",
      status: "held", createdAt: MID_MONTH,
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a money string like "1234.56" → cents integer. */
function strToCents(s: string): number {
  return Math.round(parseFloat(s) * 100);
}

// ─── Tests ───────────────────────────────────────────────────────────────────
dn("getUnitsSummaryService", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("returns per-unit + combined payout breakdown that foots and sums correctly", async () => {
    await cleanup();
    await seed();

    const result = await getUnitsSummaryService(billingCtx, OWNER, MONTH);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");

    const { month, combined, units } = result.data;
    expect(month).toBe(MONTH);

    // 1. Each unit foots: incomeCollected + depositCollected − deductibleExpenses === netPayout.
    for (const u of units) {
      const incomeC   = strToCents(u.incomeCollected);
      const depositC  = strToCents(u.depositCollected);
      const expenseC  = strToCents(u.deductibleExpenses);
      const netC      = strToCents(u.netPayout);
      expect(incomeC + depositC - expenseC).toBe(netC);
    }

    // 2. Σ(units[].netPayout) === combined.netPayout (cents arithmetic).
    expect(combined).not.toBeNull();
    const unitNetSum = units.reduce((acc, u) => acc + strToCents(u.netPayout), 0);
    const combinedNetC = strToCents(combined!.netPayout);
    expect(unitNetSum).toBe(combinedNetC);

    // 3. CONVERGENCE: combined.netPayout === getOwnerMonthsService netPayoutToOwner
    //    for the same month. This is the key invariant Task 5 must satisfy.
    const monthsResult = await getOwnerMonthsService(ledgerCtx, OWNER);
    expect(monthsResult.ok).toBe(true);
    if (!monthsResult.ok) throw new Error("unexpected error in getOwnerMonthsService");
    const monthCard = monthsResult.data.items.find((m) => m.month === MONTH);
    expect(monthCard).toBeDefined();
    expect(combined!.netPayout).toBe(monthCard!.netPayoutToOwner);
  });

  it("returns an entry per apartment with correct apartmentId + unitCode", async () => {
    await cleanup();
    await seed();

    const result = await getUnitsSummaryService(billingCtx, OWNER, MONTH);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");

    const { units } = result.data;
    expect(units.length).toBe(2);

    const aptA = units.find((u) => u.apartmentId === APT_A);
    const aptB = units.find((u) => u.apartmentId === APT_B);
    expect(aptA).toBeDefined();
    expect(aptB).toBeDefined();
    expect(aptA!.unitCode).toBe("A-05-01");
    expect(aptB!.unitCode).toBe("A-05-02");
  });

  it("returns null combined + empty units for a month with no rows", async () => {
    await cleanup();
    await seed();

    const result = await getUnitsSummaryService(billingCtx, OWNER, "2020-01");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");
    expect(result.data.combined).toBeNull();
    expect(result.data.units).toHaveLength(0);
  });

  it("surfaces NULL-apartment rows as Unassigned bucket so Σ(units incl Unassigned) === combined EXACTLY", async () => {
    await cleanup();
    await seed();

    const db = getDb();
    // Add a property-level expense with apartmentId = null (e.g. fire insurance).
    // This row lands in combined but in NO apartment bucket → without the fix,
    // Σ(units).netPayout < combined.netPayout.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG, ownerPartyId: OWNER,
        propertyId: PROPERTY, apartmentId: null, listingId: null,
        statementMonth: MONTH_START, transactionDate: MID_MONTH,
        direction: "expense", category: "insurance",
        description: "Fire insurance (property-level)", amount: "250.00", sstAmount: null,
        paidBy: "kaen", paymentStatus: "paid", taxCategory: "exempt",
        includeInPayout: true, status: "active",
        sourceType: "manual", createdById: USER, updatedById: USER,
      },
    });

    const result = await getUnitsSummaryService(billingCtx, OWNER, MONTH);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected error");

    const { combined, units } = result.data;
    expect(combined).not.toBeNull();

    // 1. Unassigned bucket exists with the null-apartment sentinel values.
    const unassigned = units.find((u) => u.apartmentId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned!.unitCode).toBe("Unassigned / property-level");

    // 2. Unassigned bucket foots: income + deposit − deductible === net (cents arithmetic).
    const uIncC = strToCents(unassigned!.incomeCollected);
    const uDepC = strToCents(unassigned!.depositCollected);
    const uExpC = strToCents(unassigned!.deductibleExpenses);
    const uNetC = strToCents(unassigned!.netPayout);
    expect(uIncC + uDepC - uExpC).toBe(uNetC);

    // 3. Σ(all units incl Unassigned) === combined EXACTLY (no cent left behind).
    const totalNetC = units.reduce((acc, u) => acc + strToCents(u.netPayout), 0);
    expect(totalNetC).toBe(strToCents(combined!.netPayout));

    const totalIncC = units.reduce((acc, u) => acc + strToCents(u.incomeCollected), 0);
    expect(totalIncC).toBe(strToCents(combined!.incomeCollected));

    const totalDepC = units.reduce((acc, u) => acc + strToCents(u.depositCollected), 0);
    expect(totalDepC).toBe(strToCents(combined!.depositCollected));

    const totalExpC = units.reduce((acc, u) => acc + strToCents(u.deductibleExpenses), 0);
    expect(totalExpC).toBe(strToCents(combined!.deductibleExpenses));

    // 4. CONVERGENCE: combined.netPayout still matches getOwnerMonthsService card
    //    (the NULL-apartment row is now counted in both, so the month card must agree).
    const monthsResult = await getOwnerMonthsService(ledgerCtx, OWNER);
    expect(monthsResult.ok).toBe(true);
    if (!monthsResult.ok) throw new Error("unexpected error in getOwnerMonthsService");
    const monthCard = monthsResult.data.items.find((m) => m.month === MONTH);
    expect(monthCard).toBeDefined();
    expect(combined!.netPayout).toBe(monthCard!.netPayoutToOwner);
  });
});
