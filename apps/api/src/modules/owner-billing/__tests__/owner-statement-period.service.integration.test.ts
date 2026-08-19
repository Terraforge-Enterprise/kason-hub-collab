/**
 * freezeStatementPeriod — compute + persist the immutable frozen snapshot
 * (Task 4). Integration test against a real LOCAL Postgres (opt-in
 * RUN_INTEGRATION=1). Proves:
 *
 *   - opening = prior month's closing (carriedForward through prevMonth); the
 *     freeze CHAINS: freeze(June).opening === freeze(May).closing.
 *   - closing / net come from resolveOwnerBalance(thisMonth) (carriedForward /
 *     netThisPeriod), persisted as integer cents (sign-aware, no float drift).
 *   - snapshotJson is CASH-BASIS: only settled (paymentStatus="paid") ACTIVE rows
 *     for the month + scope, ordered by transactionDate; unpaid + void rows are
 *     excluded even though unpaid rows DO move the (accrual) balances.
 *   - PER-UNIT scope (apartmentId set) reflects THAT unit only (ledger + deposit);
 *     combined (apartmentId null) is owner-wide — the two DIFFER.
 *   - re-freeze is idempotent: same source → same row id, no duplicate.
 *   - the idempotency key is deterministic (combined vs per-unit shapes).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/owner-billing/__tests__/owner-statement-period.service.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";

// Task 5 (freeze-time PDF attach) stubs the two EXTERNAL leaf deps of the
// post-commit PDF step so the pdfKey happy-path runs deterministically without a
// real browser or a real Storage write (the same technique owner-billing.statement
// -pdf.test.ts uses for the renderer). Chromium may be absent locally, so
// `htmlToPdf` is stubbed to a tiny Buffer (the freeze itself never launches a real
// browser here) and `putObject` is a no-op spy (no Supabase object is written).
// Both mocks are INERT for the Task 4 balance suites below — those never render or
// store — so the money computation stays fully real. The real Chromium render is
// exercised by the app + CI, not by this suite.
vi.mock("../../../lib/document-templates/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/document-templates/pdf")>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub\n")) };
});
vi.mock("../../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/storage")>();
  return { ...actual, putObject: vi.fn(async () => undefined) };
});

import { freezeStatementPeriod } from "../owner-statement-period.service";
import type { OwnerBillingActorCtx } from "../owner-billing.types";
import { putObject } from "../../../lib/storage";
import { htmlToPdf } from "../../../lib/document-templates/pdf";

// ── Safety guard — never run against a non-local DB ─────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 7a11; unused by any other suite) ───────────────
const ORG = "7a110000-0000-4000-8000-000000000001";
const OWNER = "7a110000-0000-4000-8000-000000000002";
const PROPERTY = "7a110000-0000-4000-8000-000000000003";
const ACTOR = "7a110000-0000-4000-8000-000000000004";
const TENANT = "7a110000-0000-4000-8000-000000000005";
const APT_A = "7a110000-0000-4000-8000-0000000000a1";
const APT_B = "7a110000-0000-4000-8000-0000000000b1";
const L_A = "7a110000-0000-4000-8000-0000000000a2";
const L_B = "7a110000-0000-4000-8000-0000000000b2";
const TENANCY_A = "7a110000-0000-4000-8000-0000000000a3";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" };

const MAY_M = "2026-05";
const JUNE_M = "2026-06";
const JUNE_FIRST = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

/** Exact, sign-aware 2dp-string → integer cents (mirrors owner-ledger's helper). */
function str2cents(s: string): number {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole, frac = "0"] = body.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -cents : cents;
}

type SnapLine = { amount: string; paymentStatus: string; direction: string };
const snapOf = (row: { snapshotJson: unknown }): SnapLine[] => row.snapshotJson as SnapLine[];

// ── Ledger seed helper ──────────────────────────────────────────────────────────
async function insertEntry(o: {
  apartmentId: string;
  statementMonth: Date;
  transactionDate: Date;
  direction: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      apartmentId: o.apartmentId,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: o.direction,
      category: o.direction === "income" ? "rental_income" : "management_fee",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      taxCategory: "not_applicable",
      includeInPayout: o.direction !== "income",
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      createdById: ACTOR,
      updatedById: ACTOR,
    },
  });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("owner-statement-period.service — freezeStatementPeriod (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();

    await db.organization.create({
      data: {
        id: ORG,
        name: "7A11 Freeze Service Org",
        slug: "7a11-freeze-service-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER, organizationId: ORG, displayName: "Freeze Owner", partyType: "individual", status: "active" },
    });
    await db.party.create({
      data: { id: TENANT, organizationId: ORG, displayName: "Freeze Tenant", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "Freeze Property",
        propertyCode: "7A11-P1",
        propertyType: "apartment",
        addressLine1: "1 Freeze St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "WHOLE" },
    });
    await db.apartment.create({
      data: { id: APT_B, organizationId: ORG, propertyId: PROPERTY, unitCode: "B-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L_A,
        organizationId: ORG,
        apartmentId: APT_A,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER,
      },
    });
    await db.listing.create({
      data: {
        id: L_B,
        organizationId: ORG,
        apartmentId: APT_B,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER,
      },
    });
    await db.tenancy.create({
      data: {
        id: TENANCY_A,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId: L_A,
        tenantPartyId: TENANT,
        tenancyCode: "7A11-T1",
        status: "active",
        billingStatus: "current",
        startDate: new Date(Date.UTC(2026, 0, 1)),
        monthlyRentAmount: "1000",
      },
    });

    // ── May 2026 (statementMonth 2026-05-01) — all settled income ──────────────
    const MAY_FIRST = new Date(Date.UTC(2026, 4, 1));
    await insertEntry({ apartmentId: APT_A, statementMonth: MAY_FIRST, transactionDate: new Date(Date.UTC(2026, 4, 10)), direction: "income", amount: "1000.00" });
    await insertEntry({ apartmentId: APT_B, statementMonth: MAY_FIRST, transactionDate: new Date(Date.UTC(2026, 4, 12)), direction: "income", amount: "2000.00" });

    // ── June 2026 (statementMonth 2026-06-01) ──────────────────────────────────
    // Settled (enter snapshot + move balance):
    await insertEntry({ apartmentId: APT_A, statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 5)), direction: "income", amount: "800.00" });
    await insertEntry({ apartmentId: APT_A, statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 25)), direction: "income", amount: "50.00" });
    await insertEntry({ apartmentId: APT_B, statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 3)), direction: "income", amount: "1500.00" });
    // Unpaid (excluded from snapshot; INCLUDED in accrual balance):
    await insertEntry({ apartmentId: APT_A, statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 10)), direction: "income", amount: "100.00", paymentStatus: "unpaid" });
    // Void (excluded everywhere):
    await insertEntry({ apartmentId: APT_A, statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 15)), direction: "income", amount: "999.00", status: "void" });

    // Deposit collected in June on L_A (APT_A) — non-income cash-in folded into
    // netThisPeriod + carriedForward; scoped to APT_A's listing for a per-unit freeze.
    await db.deposit.create({
      data: {
        organizationId: ORG,
        tenancyId: TENANCY_A,
        partyId: TENANT,
        unitId: L_A,
        type: "security",
        amount: "500.00",
        status: "held",
        createdAt: new Date(Date.UTC(2026, 5, 8)),
      },
    });
  });

  beforeEach(async () => {
    await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
  });

  afterAll(cleanup);

  // ── BI-1/2/3/11: opening chains from prior closing; closing/net persisted as cents ──
  it("computes opening = prior month's closing (chaining) and closing/net as cents", async () => {
    const may = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: MAY_M });
    const june = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JUNE_M });

    // May combined closing = 1000 + 2000 = 3000.00.
    expect(may.closingBalanceC).toBe(300000);

    // June opening === May closing (the headline "opening chains from prior close").
    expect(june.openingBalanceC).toBe(may.closingBalanceC);
    expect(june.openingBalanceC).toBe(300000);

    // June net = (800 + 50 + 100-unpaid active) + 1500 + 500-deposit = 2950.00.
    expect(june.netPayoutC).toBe(295000);
    // June closing = opening 3000 + net 2950 = 5950.00.
    expect(june.closingBalanceC).toBe(595000);

    // Frozen metadata.
    expect(june.status).toBe("frozen");
    expect(june.issuedAt).not.toBeNull();
    expect(june.apartmentId).toBeNull();
    expect(june.periodMonth.getTime()).toBe(JUNE_FIRST.getTime());
    expect(june.idempotencyKey).toBe(`ownerstmt:${OWNER}:${JUNE_M}`);
    expect(str2cents("5950.00")).toBe(june.closingBalanceC); // sanity: exact cents
  });

  // ── BI-4/5: cash-basis snapshot — only settled active rows, ordered, no unpaid/void ──
  it("snapshotJson holds only settled (paid) active rows ordered by date; excludes unpaid + void", async () => {
    const june = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JUNE_M });
    const lines = snapOf(june);

    // Settled June rows across both units, ordered by transactionDate:
    //   B 1500 (06-03), A 800 (06-05), A 50 (06-25).
    expect(lines.map((l) => l.amount)).toEqual(["1500.00", "800.00", "50.00"]);
    // No unpaid (100.00) and no void (999.00) row leaked in.
    expect(lines.every((l) => l.paymentStatus === "paid")).toBe(true);
    expect(lines.some((l) => l.amount === "100.00")).toBe(false);
    expect(lines.some((l) => l.amount === "999.00")).toBe(false);
  });

  // ── BI-6/7/9: per-unit scope reflects that unit only; combined is owner-wide ──
  it("scopes balances + snapshot to a single unit for a per-unit freeze; combined stays owner-wide", async () => {
    const combined = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JUNE_M });
    const unitA = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: APT_A, billingMonth: JUNE_M });
    const unitB = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: APT_B, billingMonth: JUNE_M });

    // APT_A: opening 1000 (May A), net 950 ledger + 500 deposit = 1450, closing 2450.
    expect(unitA.openingBalanceC).toBe(100000);
    expect(unitA.netPayoutC).toBe(145000);
    expect(unitA.closingBalanceC).toBe(245000);
    expect(unitA.apartmentId).toBe(APT_A);
    expect(unitA.idempotencyKey).toBe(`ownerstmt:${OWNER}:${JUNE_M}:${APT_A}`);

    // APT_B: opening 2000 (May B), net 1500 (no deposit), closing 3500.
    expect(unitB.openingBalanceC).toBe(200000);
    expect(unitB.netPayoutC).toBe(150000);
    expect(unitB.closingBalanceC).toBe(350000);

    // Combined is owner-wide and DIFFERS from either unit (proves scoping, not a
    // naive owner-wide balance stamped onto a per-unit statement).
    expect(combined.closingBalanceC).toBe(595000);
    expect(combined.closingBalanceC).not.toBe(unitA.closingBalanceC);

    // APT_A snapshot holds only APT_A settled rows: 800 (06-05), 50 (06-25).
    expect(snapOf(unitA).map((l) => l.amount)).toEqual(["800.00", "50.00"]);
  });

  // ── BI-8: idempotent re-freeze returns the same row (no duplicate) ──
  it("re-freezing the same scope returns the same row id and creates no duplicate", async () => {
    const first = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JUNE_M });
    const second = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JUNE_M });

    expect(second.id).toBe(first.id);
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG, ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE_FIRST },
    });
    expect(count).toBe(1);
  });
});

// ── Fix wave 1: monotonic-guard widening (HIGH-Row1 + HIGH-Row5) ────────────────
// sourceMaxUpdatedAt must be max(updatedAt) over ALL contributing period rows, not
// just the settled cash-basis snapshot subset — otherwise a corrective re-freeze
// after (a) a new UNPAID-active expense or (b) a void of all settled income is
// wrongly rejected as stale and the frozen statement keeps the WRONG balances.
//
// Isolated fixture (prefix 7a12) with a per-test ledger re-seed so these tests can
// MUTATE the ledger (add an expense; void income) without disturbing the BI-1..BI-11
// block above.
const ORG2 = "7a120000-0000-4000-8000-000000000001";
const OWNER2 = "7a120000-0000-4000-8000-000000000002";
const PROPERTY2 = "7a120000-0000-4000-8000-000000000003";
const ACTOR2 = "7a120000-0000-4000-8000-000000000004";
const APT2 = "7a120000-0000-4000-8000-0000000000a1";
const L2 = "7a120000-0000-4000-8000-0000000000a2";

const ctx2: OwnerBillingActorCtx = { orgId: ORG2, actorUserId: ACTOR2, actorRole: "admin" };

async function insertEntry2(o: {
  statementMonth: Date;
  transactionDate: Date;
  direction: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG2,
      ownerPartyId: OWNER2,
      propertyId: PROPERTY2,
      apartmentId: APT2,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: o.direction,
      category: o.direction === "income" ? "rental_income" : "management_fee",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      taxCategory: "not_applicable",
      includeInPayout: o.direction !== "income",
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      createdById: ACTOR2,
      updatedById: ACTOR2,
    },
  });
}

async function cleanup2() {
  const db = getDb();
  const org = { organizationId: ORG2 };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG2 } });
}

dn("owner-statement-period.service — freeze monotonic-guard widening (integration)", () => {
  beforeAll(async () => {
    await cleanup2();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG2,
        name: "7A12 Freeze Guard Org",
        slug: "7a12-freeze-guard-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER2, organizationId: ORG2, displayName: "Guard Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY2,
        organizationId: ORG2,
        name: "Guard Property",
        propertyCode: "7A12-P1",
        propertyType: "apartment",
        addressLine1: "1 Guard St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT2, organizationId: ORG2, propertyId: PROPERTY2, unitCode: "G-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L2,
        organizationId: ORG2,
        apartmentId: APT2,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER2,
      },
    });
  });

  // Fresh ledger + no frozen periods before EACH test, so a mutation in one test
  // cannot leak into the next (the RED assertions depend on an EXACT base):
  //   June 2026 — two SETTLED income rows only (opening 0, no deposits):
  //   1500 (06-03) + 800 (06-05) = 2300 gross → net 2300, closing 2300.
  beforeEach(async () => {
    const db = getDb();
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG2 } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG2 } });
    await insertEntry2({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 3)), direction: "income", amount: "1500.00" });
    await insertEntry2({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 5)), direction: "income", amount: "800.00" });
  });

  afterAll(cleanup2);

  // ── HIGH-Row1: a NEW unpaid-active expense (NOT in the cash-basis snapshot set)
  // must still advance sourceMaxUpdatedAt so a corrective re-freeze is NOT rejected
  // as stale. Pre-fix (max over the settled subset only) → re-freeze no-ops → the
  // old, too-high closing persists → owner over-paid. ─────────────────────────────
  it("re-freeze applies a NEW unpaid-active expense that lowers closing (HIGH-Row1: not rejected as stale)", async () => {
    const first = await freezeStatementPeriod(ctx2, { ownerPartyId: OWNER2, apartmentId: null, billingMonth: JUNE_M });
    expect(first.closingBalanceC).toBe(230000);
    expect(first.netPayoutC).toBe(230000);

    // Admin books a NEW unpaid-but-active June expense (includeInPayout=true): it
    // lowers the ACCRUAL net/closing by 300 even though it never enters the
    // cash-basis snapshot (paymentStatus="unpaid").
    await insertEntry2({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 20)), direction: "expense", amount: "300.00", paymentStatus: "unpaid" });

    const second = await freezeStatementPeriod(ctx2, { ownerPartyId: OWNER2, apartmentId: null, billingMonth: JUNE_M });
    // Corrected DOWN: net 2300 − 300 = 2000; closing 0 + 2000 = 2000.
    expect(second.netPayoutC).toBe(200000);
    expect(second.closingBalanceC).toBe(200000);
    expect(second.id).toBe(first.id); // the SAME row is corrected, not a duplicate
  });

  // ── HIGH-Row5: voiding ALL settled income empties the cash-basis snapshot set, so
  // pre-fix sourceMaxUpdatedAt collapses to epoch and the guard (stored ≥ epoch)
  // ALWAYS rejects the corrective re-freeze → the frozen statement keeps the voided
  // (phantom) income. The void BUMPS each row's updatedAt, so the WIDENED max advances
  // and the re-freeze is accepted. ────────────────────────────────────────────────
  it("re-freeze drops closing after ALL settled income is voided (HIGH-Row5: epoch seed no longer blocks)", async () => {
    const first = await freezeStatementPeriod(ctx2, { ownerPartyId: OWNER2, apartmentId: null, billingMonth: JUNE_M });
    expect(first.closingBalanceC).toBe(230000);

    // Mis-booked reversal: void every settled June income row. Prisma @updatedAt bumps
    // each row's updatedAt to the void time (> the first freeze's sourceMaxUpdatedAt).
    const voided = await getDb().ownerLedgerEntry.updateMany({
      where: { organizationId: ORG2, ownerPartyId: OWNER2, statementMonth: JUNE_FIRST, direction: "income", status: "active" },
      data: { status: "void" },
    });
    expect(voided.count).toBe(2);

    const second = await freezeStatementPeriod(ctx2, { ownerPartyId: OWNER2, apartmentId: null, billingMonth: JUNE_M });
    // No active income remains → net 0, closing back to opening (0).
    expect(second.netPayoutC).toBe(0);
    expect(second.closingBalanceC).toBe(0);
    expect(second.id).toBe(first.id);
  });
});

// ── Fix wave 2: snapshot + sourceMaxUpdatedAt from ONE consistent read ───────────
// The snapshot (cash-basis) AND the monotonic-guard max(updatedAt) must be derived
// from a SINGLE all-status/all-paymentStatus read, so the persisted (snapshot, max)
// pair is self-consistent: the max may reflect a row the cash-basis snapshot omits
// (an unpaid/void row), but from the SAME read — never from a separate, later query
// whose extra row would pin the strict `>=` guard and reject a faithful recompute
// forever (the wave-1 read-divergence regression). A faithful recompute of an
// unchanged state therefore reproduces the same max and no-ops rather than being
// permanently blocked.
//
// Isolated fixture (prefix 7a13) with a per-test re-seed so the "unpaid row is the
// NEWEST updatedAt" invariant is deterministic (updatedAt = createdAt at insert, so
// the last-inserted row carries the max).
const ORG3 = "7a130000-0000-4000-8000-000000000001";
const OWNER3 = "7a130000-0000-4000-8000-000000000002";
const PROPERTY3 = "7a130000-0000-4000-8000-000000000003";
const ACTOR3 = "7a130000-0000-4000-8000-000000000004";
const APT3 = "7a130000-0000-4000-8000-0000000000a1";
const L3 = "7a130000-0000-4000-8000-0000000000a2";

const ctx3: OwnerBillingActorCtx = { orgId: ORG3, actorUserId: ACTOR3, actorRole: "admin" };

async function insertEntry3(o: {
  statementMonth: Date;
  transactionDate: Date;
  direction: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG3,
      ownerPartyId: OWNER3,
      propertyId: PROPERTY3,
      apartmentId: APT3,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: o.direction,
      category: o.direction === "income" ? "rental_income" : "management_fee",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      taxCategory: "not_applicable",
      includeInPayout: o.direction !== "income",
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      createdById: ACTOR3,
      updatedById: ACTOR3,
    },
  });
}

async function cleanup3() {
  const db = getDb();
  const org = { organizationId: ORG3 };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG3 } });
}

dn("owner-statement-period.service — freeze one-read snapshot+max consistency (integration)", () => {
  beforeAll(async () => {
    await cleanup3();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG3,
        name: "7A13 One-Read Org",
        slug: "7a13-one-read-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER3, organizationId: ORG3, displayName: "One-Read Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY3,
        organizationId: ORG3,
        name: "One-Read Property",
        propertyCode: "7A13-P1",
        propertyType: "apartment",
        addressLine1: "1 OneRead St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT3, organizationId: ORG3, propertyId: PROPERTY3, unitCode: "O-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L3,
        organizationId: ORG3,
        apartmentId: APT3,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER3,
      },
    });
  });

  // Fresh ledger + no frozen periods before EACH test. Mixed June fixture, then the
  // UNPAID row is TOUCHED last so it deterministically holds max(updatedAt): the max
  // over ALL rows lands on a row the cash-basis snapshot OMITS — exactly the
  // snapshot⊂max relationship the single-read fix must keep self-consistent.
  //   paid 1500 (06-03), paid 800 (06-05)  → snapshot
  //   void 999 (06-15)                      → excluded (status void)
  //   unpaid 100 (06-10), touched last      → excluded (unpaid) BUT holds the max updatedAt
  // (Prisma @updatedAt is a build-time JS `new Date()`; four back-to-back inserts can
  // tie at ms resolution, so we explicitly bump the unpaid row after a real gap rather
  // than rely on insertion order.)
  let unpaidId3 = "";
  beforeEach(async () => {
    const db = getDb();
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG3 } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG3 } });
    await insertEntry3({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 3)), direction: "income", amount: "1500.00" });
    await insertEntry3({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 5)), direction: "income", amount: "800.00" });
    await insertEntry3({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 15)), direction: "income", amount: "999.00", status: "void" });
    const unpaid = await insertEntry3({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 10)), direction: "income", amount: "100.00", paymentStatus: "unpaid" });
    unpaidId3 = unpaid.id;
    // Bump the unpaid row's @updatedAt strictly latest (>10ms after the last insert)
    // so it deterministically holds max(updatedAt) — a snapshot-omitted row driving
    // the guard.
    await new Promise((r) => setTimeout(r, 10));
    await db.ownerLedgerEntry.update({ where: { id: unpaid.id }, data: { remarks: "touch-newest" } });
  });

  afterAll(cleanup3);

  // F1 + F2: snapshot content equals the prior cash-basis output (active+paid,
  // transactionDate asc; excludes unpaid + void) AND sourceMaxUpdatedAt equals the
  // DB max(updatedAt) over ALL period rows — which is the UNPAID row (snapshot-omitted).
  // Proves snapshot and max come from the SAME all-status read, self-consistent.
  it("derives snapshot (cash-basis) and sourceMaxUpdatedAt from one all-status read", async () => {
    const frozen = await freezeStatementPeriod(ctx3, { ownerPartyId: OWNER3, apartmentId: null, billingMonth: JUNE_M });
    const lines = snapOf(frozen);

    // Cash-basis snapshot: only the two settled active rows, ordered by transactionDate.
    expect(lines.map((l) => l.amount)).toEqual(["1500.00", "800.00"]);
    expect(lines.every((l) => l.paymentStatus === "paid")).toBe(true);
    expect(lines.some((l) => l.amount === "100.00")).toBe(false); // unpaid excluded
    expect(lines.some((l) => l.amount === "999.00")).toBe(false); // void excluded

    // The max over ALL period rows is the UNPAID row (inserted last) — a row the
    // snapshot omits. The persisted guard must reflect it (from the same read).
    const all = await getDb().ownerLedgerEntry.findMany({
      where: { organizationId: ORG3, ownerPartyId: OWNER3, statementMonth: JUNE_FIRST },
      orderBy: { updatedAt: "desc" },
    });
    const dbMax = all[0]!;
    expect(dbMax.id).toBe(unpaidId3); // the newest row is the snapshot-omitted unpaid one
    expect(dbMax.paymentStatus).toBe("unpaid");
    expect(new Date(frozen.sourceMaxUpdatedAt).getTime()).toBe(dbMax.updatedAt.getTime());
  });

  // F3: a faithful recompute of the UNCHANGED mixed state reproduces the same max, so
  // the strict `>=` guard no-ops (returns the same row) instead of permanently
  // rejecting it — the read-divergence regression can no longer pin the guard.
  it("re-freeze of the unchanged mixed state no-ops (same id, no duplicate)", async () => {
    const first = await freezeStatementPeriod(ctx3, { ownerPartyId: OWNER3, apartmentId: null, billingMonth: JUNE_M });
    const second = await freezeStatementPeriod(ctx3, { ownerPartyId: OWNER3, apartmentId: null, billingMonth: JUNE_M });

    expect(second.id).toBe(first.id);
    expect(new Date(second.sourceMaxUpdatedAt).getTime()).toBe(new Date(first.sourceMaxUpdatedAt).getTime());
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG3, ownerPartyId: OWNER3, apartmentId: null, periodMonth: JUNE_FIRST },
    });
    expect(count).toBe(1);
  });
});

// ── Task 5: render + store the frozen-statement PDF at freeze time ───────────────
// After the freeze $transaction commits, freezeStatementPeriod renders the CLEAN
// Yannie statement PDF (reusing renderCleanStatementPdfBytes) for the matching
// `owner_statement` Invoice (looked up by its OWN `owner:<owner>:<month>[:<apt>]`
// idempotency key — DIFFERENT prefix from the period's `ownerstmt:` key), stores it
// via putObject at `owner-statement-periods/<owner>/<YYYYMM>-<apt8|combined>.pdf`,
// and sets OwnerStatementPeriod.pdfKey. The step is POST-COMMIT + BEST-EFFORT: it can
// never disturb the persisted balances/snapshot and never throws out of the freeze.
//
// `htmlToPdf` (Chromium) + `putObject` (Supabase) are stubbed at the top of this file,
// so the pdfKey happy-path is deterministic here with NO real browser/Storage. The
// real Chromium render + real object write are exercised by the app + CI.
//
// Isolated fixture (prefix 7a14): org/owner/property/apartment/listing + two settled
// June income rows (opening 0, net 2300, closing 2300) and ONE combined `owner_statement`
// Invoice keyed `owner:<owner>:2026-06` (no per-unit Invoice — so the per-unit freeze
// exercises the Invoice-missing graceful path).
const ORG4 = "7a140000-0000-4000-8000-000000000001";
const OWNER4 = "7a140000-0000-4000-8000-000000000002";
const PROPERTY4 = "7a140000-0000-4000-8000-000000000003";
const ACTOR4 = "7a140000-0000-4000-8000-000000000004";
const APT4 = "7a140000-0000-4000-8000-0000000000a1";
const L4 = "7a140000-0000-4000-8000-0000000000a2";
const STMT4 = "7a140000-0000-4000-8000-0000000000c1";

const ctx4: OwnerBillingActorCtx = { orgId: ORG4, actorUserId: ACTOR4, actorRole: "admin" };
const COMBINED_KEY4 = `owner-statement-periods/${OWNER4}/202606-combined.pdf`;

async function insertEntry4(o: {
  statementMonth: Date;
  transactionDate: Date;
  direction: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG4,
      ownerPartyId: OWNER4,
      propertyId: PROPERTY4,
      apartmentId: APT4,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: o.direction,
      category: o.direction === "income" ? "rental_income" : "management_fee",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      taxCategory: "not_applicable",
      includeInPayout: o.direction !== "income",
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      createdById: ACTOR4,
      updatedById: ACTOR4,
    },
  });
}

async function cleanup4() {
  const db = getDb();
  const org = { organizationId: ORG4 };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.documentTemplate.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG4 } });
}

dn("owner-statement-period.service — freeze-time PDF attach (integration)", () => {
  beforeAll(async () => {
    await cleanup4();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG4,
        name: "7A14 Freeze PDF Org",
        slug: "7a14-freeze-pdf-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER4, organizationId: ORG4, displayName: "PDF Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY4,
        organizationId: ORG4,
        name: "PDF Property",
        propertyCode: "7A14-P1",
        propertyType: "apartment",
        addressLine1: "1 PDF St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT4, organizationId: ORG4, propertyId: PROPERTY4, unitCode: "P-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L4,
        organizationId: ORG4,
        apartmentId: APT4,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER4,
      },
    });
    // June 2026: two SETTLED income rows → opening 0, net 2300, closing 2300.
    await insertEntry4({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 3)), direction: "income", amount: "1500.00" });
    await insertEntry4({ statementMonth: JUNE_FIRST, transactionDate: new Date(Date.UTC(2026, 5, 5)), direction: "income", amount: "800.00" });
    // The COMBINED owner_statement Invoice the freeze's PDF step renders, keyed on the
    // Invoice's OWN `owner:` idempotency key (assembleYannieStatement only needs an
    // owner_statement Invoice with ownerPartyId + periodMonth). No per-unit Invoice.
    await db.invoice.create({
      data: {
        id: STMT4,
        organizationId: ORG4,
        invoiceNumber: "OS-202606-7A140000",
        partyId: OWNER4,
        ownerPartyId: OWNER4,
        propertyId: PROPERTY4,
        invoiceType: "owner_statement",
        status: "draft",
        invoiceDate: JUNE_FIRST,
        periodMonth: JUNE_FIRST,
        totalAmount: "0.00",
        sstAmount: "0.00",
        currency: "MYR",
        idempotencyKey: `owner:${OWNER4}:${JUNE_M}`,
      },
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(htmlToPdf).mockResolvedValue(Buffer.from("%PDF-stub\n"));
    vi.mocked(putObject).mockResolvedValue(undefined);
    await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG4 } });
  });

  afterAll(cleanup4);

  // BI-P1: Invoice exists → renders + stores the PDF and sets pdfKey; balances intact.
  it("attaches pdfKey + stores the PDF via putObject when the owner_statement Invoice exists", async () => {
    const frozen = await freezeStatementPeriod(ctx4, { ownerPartyId: OWNER4, apartmentId: null, billingMonth: JUNE_M });

    // Money is authoritative and UNTOUCHED by the PDF step.
    expect(frozen.openingBalanceC).toBe(0);
    expect(frozen.netPayoutC).toBe(230000);
    expect(frozen.closingBalanceC).toBe(230000);

    // pdfKey = the deterministic period key.
    expect(frozen.pdfKey).toBe(COMBINED_KEY4);

    // Stored once via putObject as application/pdf at that key, from the reused renderer.
    const calls = vi.mocked(putObject).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe(COMBINED_KEY4);
    expect(Buffer.isBuffer(calls[0]![1])).toBe(true);
    expect(calls[0]![2]).toBe("application/pdf");
    expect(vi.mocked(htmlToPdf)).toHaveBeenCalledTimes(1); // the CLEAN renderer ran (no bespoke PDF logic)

    // pdfKey is PERSISTED (survives a fresh read), not just set on the returned object.
    const reread = await getDb().ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(reread.pdfKey).toBe(COMBINED_KEY4);
  });

  // BI-P2: no matching Invoice → freeze still succeeds with pdfKey=null (graceful).
  it("freezes with pdfKey=null and stores nothing when no owner_statement Invoice exists", async () => {
    // Per-unit scope: the lookup key is `owner:<owner>:<month>:<apt>` — NO such Invoice
    // was seeded (only the combined one), so the PDF step no-ops.
    const frozen = await freezeStatementPeriod(ctx4, { ownerPartyId: OWNER4, apartmentId: APT4, billingMonth: JUNE_M });

    expect(frozen.pdfKey).toBeNull();
    // Balances are still computed + persisted (the freeze is unaffected).
    expect(frozen.closingBalanceC).toBe(230000);
    expect(frozen.apartmentId).toBe(APT4);
    // No render, no store attempted.
    expect(vi.mocked(htmlToPdf)).not.toHaveBeenCalled();
    expect(vi.mocked(putObject)).not.toHaveBeenCalled();
  });

  // BI-P3: a render/store failure is swallowed → freeze succeeds with pdfKey=null,
  // balances intact, and it NEVER throws out of freezeStatementPeriod.
  it("swallows a render error → freeze succeeds with pdfKey=null and balances intact", async () => {
    vi.mocked(htmlToPdf).mockRejectedValueOnce(new Error("Chromium unavailable (simulated)"));

    const frozen = await freezeStatementPeriod(ctx4, { ownerPartyId: OWNER4, apartmentId: null, billingMonth: JUNE_M });

    // Freeze did NOT throw; the money is intact.
    expect(frozen.netPayoutC).toBe(230000);
    expect(frozen.closingBalanceC).toBe(230000);
    // Render was ATTEMPTED (Invoice exists) but failed → pdfKey stays null, store skipped.
    expect(vi.mocked(htmlToPdf)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putObject)).not.toHaveBeenCalled();
    expect(frozen.pdfKey).toBeNull();

    // Persisted period is real + frozen with null pdfKey (balances authoritative).
    const reread = await getDb().ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(reread.pdfKey).toBeNull();
    expect(reread.closingBalanceC).toBe(230000);
  });

  // BI-P4 (constraint #3): idempotent re-freeze re-renders and OVERWRITES the same
  // deterministic key (putObject upsert), returning the SAME period row.
  it("re-freeze re-renders + overwrites the same PDF key (idempotent, same row)", async () => {
    const first = await freezeStatementPeriod(ctx4, { ownerPartyId: OWNER4, apartmentId: null, billingMonth: JUNE_M });
    const second = await freezeStatementPeriod(ctx4, { ownerPartyId: OWNER4, apartmentId: null, billingMonth: JUNE_M });

    expect(second.id).toBe(first.id);
    expect(second.pdfKey).toBe(COMBINED_KEY4);
    // Both freezes stored at the SAME key (deterministic → overwrite, no orphan).
    const calls = vi.mocked(putObject).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c[0] === COMBINED_KEY4)).toBe(true);
    // Exactly one period row (idempotent, no duplicate).
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG4, ownerPartyId: OWNER4, apartmentId: null, periodMonth: JUNE_FIRST },
    });
    expect(count).toBe(1);
  });
});

// ── Fix wave 1: closed-month freeze guard — only PAST months become statements ───
// freezeStatementPeriod must REFUSE to freeze the CURRENT (in-progress) month or any
// FUTURE month: the current open month is live "transaction history", never an
// immutable statement. If the current month were freezable, a later forward-reversal
// (Task 7) that claws back a voided paid charge would post its reversing entry into
// `curMonth` === the just-frozen month (curMonth === frozenStart) — writing an ACTIVE
// row INTO a frozen month (immutability breach) and stranding the clawback inside a
// statement instead of landing it in an open month.
//
// Date-RELATIVE fixture (prefix 7a15): the guard compares against the REAL wall clock
// (new Date()), so the "current"/"future"/"past" months are all derived from `now` at
// run time — the suite stays correct on any run date. The PAST-month seed lives in the
// month BEFORE now so the success case always targets a genuinely closed month.
const ORG5 = "7a150000-0000-4000-8000-000000000001";
const OWNER5 = "7a150000-0000-4000-8000-000000000002";
const PROPERTY5 = "7a150000-0000-4000-8000-000000000003";
const ACTOR5 = "7a150000-0000-4000-8000-000000000004";
const APT5 = "7a150000-0000-4000-8000-0000000000a1";
const L5 = "7a150000-0000-4000-8000-0000000000a2";

const ctx5: OwnerBillingActorCtx = { orgId: ORG5, actorUserId: ACTOR5, actorRole: "admin" };

const NOW5 = new Date();
const curMonthStart5 = new Date(Date.UTC(NOW5.getUTCFullYear(), NOW5.getUTCMonth(), 1));
const pastMonthStart5 = new Date(Date.UTC(NOW5.getUTCFullYear(), NOW5.getUTCMonth() - 1, 1));
const nextMonthStart5 = new Date(Date.UTC(NOW5.getUTCFullYear(), NOW5.getUTCMonth() + 1, 1));
const ym5 = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const CUR_M5 = ym5(curMonthStart5);
const PAST_M5 = ym5(pastMonthStart5);
const NEXT_M5 = ym5(nextMonthStart5);

async function cleanup5() {
  const db = getDb();
  const org = { organizationId: ORG5 };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG5 } });
}

dn("owner-statement-period.service — closed-month freeze guard (integration)", () => {
  beforeAll(async () => {
    await cleanup5();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG5,
        name: "7A15 Freeze Guard Month Org",
        slug: "7a15-freeze-guard-month-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER5, organizationId: ORG5, displayName: "Guard Month Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY5,
        organizationId: ORG5,
        name: "Guard Month Property",
        propertyCode: "7A15-P1",
        propertyType: "apartment",
        addressLine1: "1 GuardMonth St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT5, organizationId: ORG5, propertyId: PROPERTY5, unitCode: "GM-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L5,
        organizationId: ORG5,
        apartmentId: APT5,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER5,
      },
    });
    // ONE settled income row in the PAST (closed) month → that freeze has real balances.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG5,
        ownerPartyId: OWNER5,
        propertyId: PROPERTY5,
        apartmentId: APT5,
        statementMonth: pastMonthStart5,
        transactionDate: new Date(Date.UTC(pastMonthStart5.getUTCFullYear(), pastMonthStart5.getUTCMonth(), 3)),
        direction: "income",
        category: "rental_income",
        amount: "1200.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "not_applicable",
        includeInPayout: false,
        attachmentKeys: [],
        sourceType: "manual",
        status: "active",
        createdById: ACTOR5,
        updatedById: ACTOR5,
      },
    });
  });

  beforeEach(async () => {
    await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG5 } });
  });

  afterAll(cleanup5);

  // GUARD-1 (RED before the guard exists): freezing the CURRENT (in-progress) month
  // THROWS and writes NOTHING — pre-fix it would freeze the live month (no throw).
  it("refuses to freeze the CURRENT (in-progress) month and writes no period row", async () => {
    await expect(
      freezeStatementPeriod(ctx5, { ownerPartyId: OWNER5, apartmentId: null, billingMonth: CUR_M5 }),
    ).rejects.toThrow(/only closed \(past\) months/);

    // No OwnerStatementPeriod was created for the current month (guard threw pre-write).
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG5, ownerPartyId: OWNER5, periodMonth: curMonthStart5 },
    });
    expect(count).toBe(0);
  });

  // GUARD-2: a FUTURE month is likewise refused (defends the same invariant forward).
  it("refuses to freeze a FUTURE month", async () => {
    await expect(
      freezeStatementPeriod(ctx5, { ownerPartyId: OWNER5, apartmentId: null, billingMonth: NEXT_M5 }),
    ).rejects.toThrow(/only closed \(past\) months/);
  });

  // GUARD-3 (GREEN): a genuinely PAST (closed) month still freezes normally.
  it("freezes a genuinely PAST (closed) month", async () => {
    const frozen = await freezeStatementPeriod(ctx5, { ownerPartyId: OWNER5, apartmentId: null, billingMonth: PAST_M5 });
    expect(frozen.status).toBe("frozen");
    expect(frozen.periodMonth.getTime()).toBe(pastMonthStart5.getTime());
    expect(frozen.closingBalanceC).toBe(120000); // the single 1200.00 settled income row
    expect(frozen.idempotencyKey).toBe(`ownerstmt:${OWNER5}:${PAST_M5}`);
  });
});
