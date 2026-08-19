/**
 * Integration tests for owner-ledger running balance (Task 2):
 *   - resolveOwnerBalance: broughtForward / carriedForward / period figures
 *   - payout entries: includeInPayout=false enforced via deriveIncludeInPayout
 *   - sync per-category defaults: paidBy + taxCategory from OWNER_CATEGORY_DEFAULTS
 *   - org/owner scope isolation
 *
 * Hits a real LOCAL Postgres with all Phase-2 migrations applied.
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run apps/api/src/modules/owner-ledger/__tests__/owner-ledger.balance.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { resolveOwnerBalance } from "../owner-ledger.repository";
import { createEntryService, getSummaryService, voidEntryService } from "../owner-ledger.service";
import { syncMonthService } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed UUIDs — disjoint from ALL other integration test files ─────────────
// Prefix 0b to avoid collision with aaaaaaaa (repository tests) or 0c (sync tests).

const ORG    = "0b000000-0000-4000-8000-000000000001";
const USER   = "0b000000-0000-4000-8000-000000000002";
const PARTY  = "0b000000-0000-4000-8000-000000000003";
const OWNER  = "0b000000-0000-4000-8000-000000000004";
const OWNER2 = "0b000000-0000-4000-8000-000000000005"; // for scope-isolation test
const PROPERTY  = "0b000000-0000-4000-8000-000000000006";
const ACTOR_USER = "0b000000-0000-4000-8000-000000000007";

// For sync defaults sub-test
const PROPERTY2  = "0b000000-0000-4000-8000-000000000010";
const APARTMENT2 = "0b000000-0000-4000-8000-000000000011";
const UNIT2      = "0b000000-0000-4000-8000-000000000012";
const TENANCY2   = "0b000000-0000-4000-8000-000000000013";
const TENANT2    = "0b000000-0000-4000-8000-000000000014";

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest-balance",
};

// ─── Cleanup helper ───────────────────────────────────────────────────────────

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
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

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Balance Test Org",
      slug: "balance-test-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Balance Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "balance-op@example.com",
      fullName: "Balance Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "Balance Owner", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: OWNER2, organizationId: ORG, displayName: "Balance Owner2", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Balance Test Property",
      propertyCode: "BAL-P1",
      propertyType: "apartment",
      addressLine1: "1 Balance St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
}

/**
 * Insert a ledger entry directly for testing, bypassing the service (no audit).
 */
async function insertEntry(overrides: {
  ownerPartyId?: string;
  statementMonth: Date;
  direction: string;
  category: string;
  amount: string;
  includeInPayout?: boolean;
  direction_?: never;
}) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: overrides.ownerPartyId ?? OWNER,
      propertyId: PROPERTY,
      statementMonth: overrides.statementMonth,
      transactionDate: overrides.statementMonth,
      direction: overrides.direction,
      category: overrides.category,
      amount: overrides.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "check_with_tax_agent",
      includeInPayout: overrides.includeInPayout ?? (overrides.direction === "expense"),
      attachmentKeys: [],
      sourceType: "manual",
      status: "active",
      createdById: ACTOR_USER,
      updatedById: ACTOR_USER,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

dn("owner-ledger.balance — resolveOwnerBalance + payout + sync-defaults", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── (a) 3-month negative carry-forward scenario ───────────────────────────

  it("(a) resolveOwnerBalance: negative carry-forward propagates correctly across months", async () => {
    // April: income 1000, expense 1200 → net = -200
    const apr = new Date(Date.UTC(2026, 3, 1)); // 2026-04-01
    await insertEntry({ statementMonth: apr, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: apr, direction: "expense", category: "management_fee", amount: "1200.00", includeInPayout: true });

    // May: income 1500, expense 800 → net = +700
    const may = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01
    await insertEntry({ statementMonth: may, direction: "income", category: "rental_income", amount: "1500.00", includeInPayout: false });
    await insertEntry({ statementMonth: may, direction: "expense", category: "management_fee", amount: "800.00", includeInPayout: true });

    // June: income 800, expense 300 → net = +500
    const jun = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
    await insertEntry({ statementMonth: jun, direction: "income", category: "rental_income", amount: "800.00", includeInPayout: false });
    await insertEntry({ statementMonth: jun, direction: "expense", category: "management_fee", amount: "300.00", includeInPayout: true });

    // Query for May only
    const result = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");

    // broughtForward = Apr balance = 1000 - 1200 = -200
    expect(result.broughtForward).toBe("-200.00");
    // period = May only
    expect(result.periodGross).toBe("1500.00");
    expect(result.periodExpenses).toBe("800.00");
    expect(result.periodPayouts).toBe("0.00");
    expect(result.netThisPeriod).toBe("700.00");
    // carriedForward = Apr + May balance = (1000+1500)-(1200+800) = 500
    expect(result.carriedForward).toBe("500.00");
  });

  // ── (b) payout reduces carriedForward AND has includeInPayout=false ─────────

  it("(b) payout reduces carriedForward; createEntryService enforces includeInPayout=false for payout", async () => {
    // April: income 1000, expense 1200 → balance = -200
    const apr = new Date(Date.UTC(2026, 3, 1));
    await insertEntry({ statementMonth: apr, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: apr, direction: "expense", category: "management_fee", amount: "1200.00", includeInPayout: true });

    // May: income 1500, expense 800 → sub-balance +700
    const may = new Date(Date.UTC(2026, 4, 1));
    await insertEntry({ statementMonth: may, direction: "income", category: "rental_income", amount: "1500.00", includeInPayout: false });
    await insertEntry({ statementMonth: may, direction: "expense", category: "management_fee", amount: "800.00", includeInPayout: true });

    // Add a payout of 300 in May via createEntryService to test includeInPayout enforcement
    const payoutResult = await createEntryService(ctx, {
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      statementMonth: "2026-05",
      transactionDate: "2026-05-15",
      direction: "payout",
      category: "owner_payout",
      amount: "300.00",
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      attachmentKeys: [],
    });

    expect(payoutResult.ok).toBe(true);
    if (!payoutResult.ok) return;

    // The payout entry itself must have includeInPayout=false
    expect(payoutResult.data.includeInPayout).toBe(false);

    // With payout: balance for [fromMonth=2026-05, toMonth=2026-05]
    const result = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");

    // broughtForward = Apr balance = 1000 - 1200 = -200
    expect(result.broughtForward).toBe("-200.00");
    // periodPayouts = 300
    expect(result.periodPayouts).toBe("300.00");
    // carriedForward = (1000-1200) + (1500-800-300) = -200 + 400 = 200
    expect(result.carriedForward).toBe("200.00");
  });

  // ── (f) MONEY-GATE: voiding a payout restores the balance ───────────────────
  // The panel-#8 void affordance reuses voidEntryService untouched. Because every
  // balance read filters status:"active", voiding a payout must return
  // carriedForward + periodPayouts to their pre-payout values AND leave the
  // income/expense figures untouched (audit finding: bystander invariance).

  it("(f) voiding a payout restores the balance (carriedForward + periodPayouts)", async () => {
    // April: income 1000, expense 1200 → balance = -200
    const apr = new Date(Date.UTC(2026, 3, 1));
    await insertEntry({ statementMonth: apr, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: apr, direction: "expense", category: "management_fee", amount: "1200.00", includeInPayout: true });

    // May: income 1500, expense 800 → sub-balance +700
    const may = new Date(Date.UTC(2026, 4, 1));
    await insertEntry({ statementMonth: may, direction: "income", category: "rental_income", amount: "1500.00", includeInPayout: false });
    await insertEntry({ statementMonth: may, direction: "expense", category: "management_fee", amount: "800.00", includeInPayout: true });

    // Pre-payout snapshot: carriedForward = -200 + (1500-800) = 500; no payouts.
    const prePayout = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(prePayout.carriedForward).toBe("500.00");
    expect(prePayout.periodPayouts).toBe("0.00");

    // Record a 300 payout → carriedForward drops to 200, periodPayouts = 300.
    const payoutResult = await createEntryService(ctx, {
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      statementMonth: "2026-05",
      transactionDate: "2026-05-15",
      direction: "payout",
      category: "owner_payout",
      amount: "300.00",
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      attachmentKeys: [],
    });
    expect(payoutResult.ok).toBe(true);
    if (!payoutResult.ok) return;

    const withPayout = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(withPayout.periodPayouts).toBe("300.00");
    expect(withPayout.carriedForward).toBe("200.00");

    // Void the payout via the SAME service the #8 panel affordance calls.
    const voided = await voidEntryService(ctx, payoutResult.data.id, payoutResult.data.updatedAt);
    expect(voided.ok).toBe(true);

    // Re-read AFTER the void — balance must be restored.
    const afterVoid = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(afterVoid.carriedForward).toBe("500.00");
    expect(afterVoid.periodPayouts).toBe("0.00");
    // Bystander invariance — only the payout figures moved.
    expect(afterVoid.periodGross).toBe(prePayout.periodGross);
    expect(afterVoid.periodExpenses).toBe(prePayout.periodExpenses);
    expect(afterVoid.netThisPeriod).toBe(prePayout.netThisPeriod);
    expect(afterVoid.broughtForward).toBe(prePayout.broughtForward);
  });

  // ── (g) voiding ONE of two payouts leaves the other active ──────────────────
  // Guards against a void zeroing ALL payouts or double-subtracting: only the
  // voided amount comes back; the sibling payout stays counted.

  it("(g) voiding one of two payouts restores only its amount, sibling stays active", async () => {
    const may = new Date(Date.UTC(2026, 4, 1));
    await insertEntry({ statementMonth: may, direction: "income", category: "rental_income", amount: "1500.00", includeInPayout: false });
    await insertEntry({ statementMonth: may, direction: "expense", category: "management_fee", amount: "800.00", includeInPayout: true });

    const p1 = await createEntryService(ctx, {
      ownerPartyId: OWNER, propertyId: PROPERTY, statementMonth: "2026-05",
      transactionDate: "2026-05-10", direction: "payout", category: "owner_payout",
      amount: "300.00", paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable", attachmentKeys: [],
    });
    const p2 = await createEntryService(ctx, {
      ownerPartyId: OWNER, propertyId: PROPERTY, statementMonth: "2026-05",
      transactionDate: "2026-05-20", direction: "payout", category: "owner_payout",
      amount: "200.00", paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable", attachmentKeys: [],
    });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;

    // Both payouts present: periodPayouts 500; carriedForward = 700 - 500 = 200.
    const both = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(both.periodPayouts).toBe("500.00");
    expect(both.carriedForward).toBe("200.00");

    // Void ONLY p1 (300); p2 (200) must stay active.
    const voided = await voidEntryService(ctx, p1.data.id, p1.data.updatedAt);
    expect(voided.ok).toBe(true);

    // Re-read AFTER voiding ONLY p1 (300) — p2 (200) must stay active.
    const afterVoid = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    // periodPayouts drops to just p2's 200; carriedForward restored by EXACTLY
    // the voided 300 (200 → 500), not zeroed to 700.
    expect(afterVoid.periodPayouts).toBe("200.00");
    expect(afterVoid.carriedForward).toBe("500.00");
  });

  // ── (h) BOUNDARY: voiding the SOLE payout (no income/expense) → clean 0.00 ───
  // An owner whose only active row is the payout: voiding it leaves ZERO active
  // rows. resolveOwnerBalance must resolve to "0.00" across the board, never NaN
  // / undefined from an empty aggregate.

  it("(h) voiding the sole payout of a payout-only owner resolves to 0.00, not NaN", async () => {
    // ONLY a payout — no income, no expense.
    const payout = await createEntryService(ctx, {
      ownerPartyId: OWNER, propertyId: PROPERTY, statementMonth: "2026-05",
      transactionDate: "2026-05-15", direction: "payout", category: "owner_payout",
      amount: "300.00", paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable", attachmentKeys: [],
    });
    expect(payout.ok).toBe(true);
    if (!payout.ok) return;

    // With the payout: periodPayouts 300, carriedForward = 0 - 300 = -300.
    const withPayout = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(withPayout.periodPayouts).toBe("300.00");

    // Void the sole payout via the reused void path → zero active rows remain.
    const voided = await voidEntryService(ctx, payout.data.id, payout.data.updatedAt);
    expect(voided.ok).toBe(true);

    // Re-read AFTER voiding the sole payout — zero active rows.
    const afterVoid = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(afterVoid.periodPayouts).toBe("0.00");
    expect(afterVoid.carriedForward).toBe("0.00");
    expect(afterVoid.broughtForward).toBe("0.00");
    expect(afterVoid.periodGross).toBe("0.00");
    expect(afterVoid.periodExpenses).toBe("0.00");
    expect(afterVoid.netThisPeriod).toBe("0.00");
  });

  // ── (c) sync sets per-category paidBy + taxCategory from OWNER_CATEGORY_DEFAULTS ──

  it("(c) syncMonthService sets paidBy + taxCategory from OWNER_CATEGORY_DEFAULTS per category", async () => {
    // Seed the minimal infrastructure for syncMonthService
    const db = getDb();
    await db.party.create({
      data: { id: TENANT2, organizationId: ORG, displayName: "Balance Tenant", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY2,
        organizationId: ORG,
        name: "Sync Defaults Property",
        propertyCode: "BAL-P2",
        propertyType: "apartment",
        addressLine1: "2 Sync St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APARTMENT2, organizationId: ORG, propertyId: PROPERTY2, unitCode: "B-1", listingMode: "PARTITIONED" },
    });
    await db.listing.create({
      data: {
        id: UNIT2,
        organizationId: ORG,
        apartmentId: APARTMENT2,
        listingType: "room",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        // Owner re-point: sync resolves the owner's units via Listing.ownerPartyId.
        ownerPartyId: OWNER,
      },
    });
    await db.tenancy.create({
      data: {
        id: TENANCY2,
        organizationId: ORG,
        propertyId: PROPERTY2,
        unitId: UNIT2,
        tenantPartyId: TENANT2,
        tenancyCode: "BAL-SYNC-T1",
        status: "active",
        billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        monthlyRentAmount: "1500",
      },
    });
    await db.landlordTenancy.create({
      data: {
        organizationId: ORG,
        propertyId: PROPERTY2,
        landlordId: OWNER,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        monthlyRent: "1500",
        status: "active",
      },
    });

    const MONTH = "2026-05";
    const monthStart = new Date(Date.UTC(2026, 4, 1));

    // Rent charge
    await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "BAL-SYNC-RENT-1",
        tenancyId: TENANCY2,
        unitId: UNIT2,
        partyId: TENANT2,
        chargeType: "rent",
        status: "posted",
        dueDate: new Date(Date.UTC(2026, 4, 5)),
        amount: "1500.00",
        currency: "MYR",
        outstandingAmount: "0.00",
      },
    });

    // Owner statement Invoice with management_fee + cleaning
    const invoice = await db.invoice.create({
      data: {
        organizationId: ORG,
        invoiceNumber: "BAL-SYNC-INV-1",
        partyId: OWNER,
        ownerPartyId: OWNER,
        propertyId: PROPERTY2,
        invoiceType: "owner_statement",
        status: "draft",
        invoiceDate: monthStart,
        periodMonth: monthStart,
        totalAmount: "316.00",
        sstAmount: "16.00",
        currency: "MYR",
        idempotencyKey: `owner:${OWNER}:${MONTH}`,
      },
    });
    await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "BAL-SYNC-STMT-MGMT",
        unitId: UNIT2,
        partyId: OWNER,
        chargeType: "management_fee",
        status: "draft",
        dueDate: monthStart,
        amount: "200.00",
        currency: "MYR",
        outstandingAmount: "200.00",
        invoiceId: invoice.id,
        billingMonth: monthStart,
      },
    });
    await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: "BAL-SYNC-STMT-CLEAN",
        unitId: UNIT2,
        partyId: OWNER,
        chargeType: "cleaning",
        status: "draft",
        dueDate: monthStart,
        amount: "100.00",
        currency: "MYR",
        outstandingAmount: "100.00",
        invoiceId: invoice.id,
        billingMonth: monthStart,
      },
    });

    const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const rows = await db.ownerLedgerEntry.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER },
    });

    const rentRow = rows.find((r) => r.sourceType === "rent");
    expect(rentRow).toBeDefined();
    // rental_income default: paidBy="kaen", taxCategory="not_applicable"
    expect(rentRow!.paidBy).toBe("kaen");
    expect(rentRow!.taxCategory).toBe("not_applicable");

    const mgmtRow = rows.find((r) => r.category === "management_fee");
    expect(mgmtRow).toBeDefined();
    // management_fee default: paidBy="kaen", taxCategory="rental_expense"
    expect(mgmtRow!.paidBy).toBe("kaen");
    expect(mgmtRow!.taxCategory).toBe("rental_expense");

    const cleanRow = rows.find((r) => r.category === "cleaning");
    expect(cleanRow).toBeDefined();
    // cleaning default: paidBy="kaen", taxCategory="not_applicable"
    expect(cleanRow!.paidBy).toBe("kaen");
    expect(cleanRow!.taxCategory).toBe("not_applicable");
  });

  // ── (d) org/owner scope isolation ──────────────────────────────────────────

  it("(d) resolveOwnerBalance only returns rows for the specific owner, not other owners in the same org", async () => {
    const may = new Date(Date.UTC(2026, 4, 1));

    // OWNER: income 1000
    await insertEntry({ ownerPartyId: OWNER, statementMonth: may, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });

    // OWNER2: income 5000, expense 3000
    await insertEntry({ ownerPartyId: OWNER2, statementMonth: may, direction: "income", category: "rental_income", amount: "5000.00", includeInPayout: false });
    await insertEntry({ ownerPartyId: OWNER2, statementMonth: may, direction: "expense", category: "management_fee", amount: "3000.00", includeInPayout: true });

    // Query for OWNER only — OWNER2's entries must not bleed in
    const result = await resolveOwnerBalance(ORG, OWNER, "2026-05", "2026-05");
    expect(result.periodGross).toBe("1000.00");
    expect(result.periodExpenses).toBe("0.00");
    expect(result.carriedForward).toBe("1000.00");

    // Query for OWNER2 — should only see OWNER2's entries
    const result2 = await resolveOwnerBalance(ORG, OWNER2, "2026-05", "2026-05");
    expect(result2.periodGross).toBe("5000.00");
    expect(result2.periodExpenses).toBe("3000.00");
    expect(result2.carriedForward).toBe("2000.00");
  });

  // ── (e) getSummaryService integrates balance into its response ───────────────

  it("(e) getSummaryService includes broughtForward + carriedForward in its response", async () => {
    const apr = new Date(Date.UTC(2026, 3, 1));
    const may = new Date(Date.UTC(2026, 4, 1));

    // April: income 1000, expense 400
    await insertEntry({ statementMonth: apr, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: apr, direction: "expense", category: "management_fee", amount: "400.00", includeInPayout: true });

    // May: income 800, expense 200
    await insertEntry({ statementMonth: may, direction: "income", category: "rental_income", amount: "800.00", includeInPayout: false });
    await insertEntry({ statementMonth: may, direction: "expense", category: "management_fee", amount: "200.00", includeInPayout: true });

    const result = await getSummaryService(ctx, {
      ownerPartyId: OWNER,
      fromMonth: "2026-05",
      toMonth: "2026-05",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Period (May only)
    expect(result.data.grossRental).toBe("800.00");
    expect(result.data.totalExpenses).toBe("200.00");

    // Balance fields
    // broughtForward = Apr balance = 1000 - 400 = 600
    expect(result.data.broughtForward).toBe("600.00");
    // carriedForward = Apr + May = (1000+800) - (400+200) = 1200
    expect(result.data.carriedForward).toBe("1200.00");
    expect(result.data.netThisPeriod).toBe("600.00"); // May gross - May payout-expenses
    expect(result.data.payoutsTotal).toBe("0.00");
  });
});
