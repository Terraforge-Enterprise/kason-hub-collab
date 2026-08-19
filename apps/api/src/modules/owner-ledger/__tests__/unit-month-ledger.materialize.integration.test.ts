/**
 * Task 2: materializeOwnerUnitMonths — parity integration test (RED → GREEN).
 *
 * Verifies the PARITY guarantee:
 *   For each owned apartment, the UnitMonthLedger row written by
 *   materializeOwnerUnitMonths must be cent-for-cent equal to the live
 *   resolveOwnerPayoutForScope result (null → zero row).
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (f6..).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getDb } from "@kason/db";
import { resolveOwnerPayoutForScope } from "../owner-payout-scope.service";
import { materializeOwnerUnitMonths } from "../unit-month-ledger.materialize";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed UUIDs — prefix f6 (unique to this test file, all-hex) ─────────────
const ORG      = "f6000000-0000-4000-8000-000000000001";
const USER     = "f6000000-0000-4000-8000-000000000002";
const PARTY_OP = "f6000000-0000-4000-8000-000000000003";
const OWNER    = "f6000000-0000-4000-8000-000000000004";
const TENANT   = "f6000000-0000-4000-8000-000000000005";
const PROPERTY = "f6000000-0000-4000-8000-000000000006";

const APT1     = "f6000000-0000-4000-8000-0000000000a1";
const APT2     = "f6000000-0000-4000-8000-0000000000b1";
const APT3     = "f6000000-0000-4000-8000-0000000000c1";

const LISTING1 = "f6000000-0000-4000-8000-0000000000a2";
const LISTING2 = "f6000000-0000-4000-8000-0000000000b2";
const LISTING3 = "f6000000-0000-4000-8000-0000000000c2";

const TENANCY1 = "f6000000-0000-4000-8000-0000000000a3";
const TENANCY2 = "f6000000-0000-4000-8000-0000000000b3";

const MONTH      = "2025-08";
const MONTH_START = new Date(Date.UTC(2025, 7, 1)); // 2025-08-01T00:00:00Z
const MID_MONTH  = new Date(Date.UTC(2025, 7, 15));

const billingCtx: OwnerBillingActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
};

const ledgerCtx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
};

// ─── Cleanup ─────────────────────────────────────────────────────────────────
async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.unitMonthLedger.deleteMany({ where: org });
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
      id: ORG, name: "Materialize Org", slug: "materialize-org",
      status: "active", defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: PARTY_OP, organizationId: ORG, displayName: "Materialize Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "materialize-op@example.com", fullName: "Materialize Op", status: "active", role: "admin", userType: "operator", partyId: PARTY_OP } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Materialize Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Materialize Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Materialize Residences",
      propertyCode: "MAT1", propertyType: "apartment",
      addressLine1: "6 Materialize St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });

  // Two apartments with one listing each.
  await db.apartment.create({ data: { id: APT1, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-06-01", listingMode: "WHOLE" } });
  await db.apartment.create({ data: { id: APT2, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-06-02", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING1, organizationId: ORG, apartmentId: APT1, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.listing.create({ data: { id: LISTING2, organizationId: ORG, apartmentId: APT2, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });

  // Tenancies — required as FK for Deposit.
  await db.tenancy.create({ data: { id: TENANCY1, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING1, tenantPartyId: TENANT, tenancyCode: "MAT-T1", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "1500.00" } });
  await db.tenancy.create({ data: { id: TENANCY2, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING2, tenantPartyId: TENANT, tenancyCode: "MAT-T2", status: "active", billingStatus: "current", startDate: new Date("2025-01-01T00:00:00.000Z"), monthlyRentAmount: "900.00" } });

  // ManagementFeeConfig — 10% + 8% SST (all-properties, no override).
  await db.managementFeeConfig.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: null,
      feeType: "percent", feeValue: "10.00", capAmount: null,
      sstPercent: "8.00", isActive: true,
    },
  });

  // OwnerLedgerEntry rows for Apt 1 — income 1500, expense 200.
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT1, listingId: LISTING1,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent APT1", amount: "1500.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT1, listingId: LISTING1,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "expense", category: "maintenance",
      description: "Aug maintenance APT1", amount: "200.00", sstAmount: null,
      paidBy: "owner", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // OwnerLedgerEntry rows for Apt 2 — income 900 only (no expense).
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER,
      propertyId: PROPERTY, apartmentId: APT2, listingId: LISTING2,
      statementMonth: MONTH_START, transactionDate: MID_MONTH,
      direction: "income", category: "rental_income",
      description: "Aug rent APT2", amount: "900.00", sstAmount: null,
      paidBy: "tenant", paymentStatus: "paid", taxCategory: "exempt",
      includeInPayout: true, status: "active",
      sourceType: "manual", createdById: USER, updatedById: USER,
    },
  });

  // Deposit for Apt 1 (collected in MONTH).
  await db.deposit.create({
    data: {
      organizationId: ORG,
      tenancyId: TENANCY1,
      partyId: TENANT, unitId: LISTING1,
      type: "security", amount: "3000.00",
      status: "held", createdAt: MID_MONTH,
    },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────
dn("materializeOwnerUnitMonths — parity with live engine", () => {
  // The sync-hook + fan-out materialization is gated on ENABLE_UNIT_MONTH_LEDGER.
  // Enable it for this file's lifecycle; clear in afterAll to avoid leaking into
  // other integration files (they run sequentially in one process).
  beforeAll(() => {
    process.env.ENABLE_UNIT_MONTH_LEDGER = "true";
  });

  afterAll(async () => {
    delete process.env.ENABLE_UNIT_MONTH_LEDGER;
    await cleanup();
  });

  it("writes one UnitMonthLedger row per owned apartment, cent-for-cent equal to resolveOwnerPayoutForScope", async () => {
    await cleanup();
    await seed();
    const db = getDb();

    const res = await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    expect(res.upserted).toBeGreaterThanOrEqual(2);

    for (const aptId of [APT1, APT2]) {
      const live = await resolveOwnerPayoutForScope(billingCtx, OWNER, MONTH, aptId);
      const row = await db.unitMonthLedger.findUnique({
        where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: aptId, periodMonth: MONTH_START } },
      });
      expect(row).not.toBeNull();
      // live === null (no rows) maps to a zero row; otherwise cent-for-cent.
      expect(row!.incomeC).toBe(live?.grossRentalC ?? 0);
      expect(row!.deductibleExpensesC).toBe(live?.deductibleExpensesC ?? 0);
      expect(row!.netPayoutC).toBe(live?.totalPayoutC ?? 0);
      expect(row!.mgmtFeeC).toBe(live?.computedMgmtBaseC ?? 0);
      expect(row!.sstC).toBe(live?.computedMgmtSstC ?? 0);
    }
  });

  it("writes a ZERO row for an owned apartment with no ledger rows (parity with live null→zero)", async () => {
    await cleanup();
    await seed();
    const db = getDb();

    // Add APT3 — owned but with no ledger rows for MONTH.
    await db.apartment.create({ data: { id: APT3, organizationId: ORG, propertyId: PROPERTY, unitCode: "C-01-01", listingMode: "WHOLE" } });
    await db.listing.create({ data: { id: LISTING3, organizationId: ORG, apartmentId: APT3, listingType: "unit", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });

    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);

    const row = await db.unitMonthLedger.findUnique({
      where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT3, periodMonth: MONTH_START } },
    });
    expect(row).not.toBeNull();
    expect(row!.incomeC).toBe(0);
    expect(row!.netPayoutC).toBe(0);
  });

  it("syncMonthService materializes UnitMonthLedger rows as a side effect (best-effort)", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await db.unitMonthLedger.deleteMany({ where: { organizationId: ORG } });
    const { syncMonthService } = await import("../owner-ledger.sync");
    const r = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(r.ok).toBe(true);
    const rows = await db.unitMonthLedger.findMany({ where: { organizationId: ORG, periodMonth: MONTH_START } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  // ── Removal-path parity (C1/C2 — the scenarios the removed monotonic guard broke) ──

  it("void a NON-LAST row → materialize drops the figure to match the live engine (C1)", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH); // warm: APT1 income+expense
    const before = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } });
    // Void APT1's income row (the expense row survives → NON-last removal).
    await db.ownerLedgerEntry.updateMany({ where: { organizationId: ORG, apartmentId: APT1, direction: "income" }, data: { status: "void" } });
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    const after = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } });
    const live = await resolveOwnerPayoutForScope(billingCtx, OWNER, MONTH, APT1);
    expect(after!.incomeC).toBeLessThan(before!.incomeC); // old guard would have SKIPPED this write
    expect(after!.incomeC).toBe(live?.grossRentalC ?? 0);
    expect(after!.netPayoutC).toBe(live?.totalPayoutC ?? 0);
  });

  it("void the LAST active row → materialize ZEROES the row (C1; old guard left it stale)", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    const before = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT2, periodMonth: MONTH_START } } });
    expect(before!.incomeC).toBeGreaterThan(0); // APT2 had income 900
    await db.ownerLedgerEntry.updateMany({ where: { organizationId: ORG, apartmentId: APT2 }, data: { status: "void" } });
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    const after = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT2, periodMonth: MONTH_START } } });
    expect(after).not.toBeNull();          // owned-but-empty apartment keeps a row
    expect(after!.incomeC).toBe(0);        // …now zeroed (old guard left it at 90000)
    expect(after!.netPayoutC).toBe(0);
    expect(await resolveOwnerPayoutForScope(billingCtx, OWNER, MONTH, APT2)).toBeNull();
  });

  it("retire the fee config → materialize recomputes mgmtFeeC to 0, matching the live engine", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    const before = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } });
    expect(before!.mgmtFeeC).toBeGreaterThan(0);
    await db.managementFeeConfig.updateMany({ where: { organizationId: ORG, ownerPartyId: OWNER }, data: { isActive: false } });
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    const after = await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } });
    const live = await resolveOwnerPayoutForScope(billingCtx, OWNER, MONTH, APT1);
    expect(after!.mgmtFeeC).toBe(0);
    expect(after!.mgmtFeeC).toBe(live?.computedMgmtBaseC ?? 0);
    expect(after!.netPayoutC).toBe(live?.totalPayoutC ?? 0);
  });

  it("owner cleared to null → materialize DELETES the now-unowned apartment's stale row (C2)", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    expect(await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } })).not.toBeNull();
    // Clear APT1's owner → the apartment leaves OWNER's non-archived-listing set.
    await db.listing.updateMany({ where: { organizationId: ORG, apartmentId: APT1 }, data: { ownerPartyId: null } });
    await materializeOwnerUnitMonths(billingCtx, OWNER, MONTH);
    expect(await db.unitMonthLedger.findUnique({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT1, periodMonth: MONTH_START } } })).toBeNull();
  });

  it("recompute with NO ownerPartyId re-materializes ALL owners for the month (finding G)", async () => {
    await cleanup(); await seed();
    const db = getDb();
    await db.unitMonthLedger.deleteMany({ where: { organizationId: ORG } });
    const { recomputeUnitMonthLedgerService } = await import("../owner-ledger.service");
    const r = await recomputeUnitMonthLedgerService(billingCtx, { month: MONTH });
    expect(r.ok).toBe(true);
    const rows = await db.unitMonthLedger.findMany({ where: { organizationId: ORG, periodMonth: MONTH_START } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
