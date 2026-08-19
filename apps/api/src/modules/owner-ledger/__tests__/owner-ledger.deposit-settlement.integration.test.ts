/**
 * C3/C4 — deposit-aware settlement of the owner statement (gaps G5 + G6 + close-out).
 *
 * Deposits are a NON-INCOME cash-in (Yannie "Add: Deposit Collected This Month").
 * Phase-2 left them out of the running balance, so recording the deposit-inclusive
 * Total Payout against a deposit-BLIND balance made carry-forward wrong by the
 * deposit amount. These tests pin the corrected math:
 *
 *   G5  /months depositCollected = findDepositsCollectedInMonth (matches the
 *       statement assembled by assembleYannieStatement).
 *   G6  resolveOwnerBalance threads the deposit as a non-income cash-in:
 *       carriedForward = Σ(income − deductible expense + deposit) − Σ payouts,
 *       and the partition identity broughtForward + netThisPeriod − payouts =
 *       carriedForward holds WITH the deposit included.
 *   C4  a recorded owner_payout for the full deposit-aware net zeroes the balance;
 *       a negative month ("KAEN fronted") carries forward and next month nets it.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (0f..).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { resolveOwnerBalance } from "../owner-ledger.repository";
import { createEntryService, getOwnerMonthsService, getSummaryService } from "../owner-ledger.service";
import { assembleYannieStatement } from "../../owner-billing/owner-statement-sections";
import { findDepositsCollectedInMonth, findDepositsHeldForUnits, depositWindowEndOfMonth } from "../../owner-billing/owner-billing.repository";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "0f000000-0000-4000-8000-000000000001";
const USER = "0f000000-0000-4000-8000-000000000002";
const PARTY = "0f000000-0000-4000-8000-000000000003";
const OWNER = "0f000000-0000-4000-8000-000000000004";
const TENANT = "0f000000-0000-4000-8000-000000000005";
const PROPERTY = "0f000000-0000-4000-8000-000000000006";
const APARTMENT = "0f000000-0000-4000-8000-000000000007";
const LISTING = "0f000000-0000-4000-8000-000000000008";
const TENANCY = "0f000000-0000-4000-8000-000000000009";

const ctx: OwnerLedgerActorCtx = {
  orgId: ORG,
  actorUserId: USER,
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest-deposit-settlement",
};

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
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

async function seedOrg() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "Deposit Settle Org", slug: "deposit-settle-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Settle Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "settle-op@example.com", fullName: "Settle Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Settle Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Settle Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "Settle Property", propertyCode: "STL-P1", propertyType: "apartment", addressLine1: "1 Settle St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "S-01", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: LISTING, organizationId: ORG, apartmentId: APARTMENT, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROPERTY, unitId: LISTING, tenantPartyId: TENANT, tenancyCode: "STL-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000" } });
}

/** Insert a ledger entry directly (bypasses the service — no audit). */
async function insertEntry(o: { statementMonth: Date; direction: string; category: string; amount: string; includeInPayout?: boolean }) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      listingId: LISTING,
      statementMonth: o.statementMonth,
      transactionDate: o.statementMonth,
      direction: o.direction,
      category: o.category,
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "check_with_tax_agent",
      includeInPayout: o.includeInPayout ?? (o.direction === "expense"),
      attachmentKeys: [],
      sourceType: "manual",
      status: "active",
      createdById: USER,
      updatedById: USER,
    },
  });
}

/**
 * Insert a deposit RELEASED to the owner, collected (createdAt) on the owner's
 * listing — i.e. deposit cash the owner actually receives.
 *
 * Was `status: "held"` until 2026-08-18, when KAEN's holding of tenancy deposits
 * was made explicit: a held deposit is the tenant's money and must never inflate
 * an owner payout, so findDepositsCollectedInMonth now counts only
 * `released_to_owner`. Every assertion below is about HOW a counted deposit flows
 * (carry-forward, the partition identity, last-day month attribution) — none of
 * them was ever about WHICH deposits count — so seeding the released status keeps
 * all of that arithmetic coverage intact under the corrected rule.
 *
 * `insertHeldDeposit` below covers the other half: that a held one counts zero.
 */
async function insertDeposit(amount: string, createdAt: Date) {
  const db = getDb();
  return db.deposit.create({
    data: { organizationId: ORG, tenancyId: TENANCY, partyId: TENANT, unitId: LISTING, type: "security", amount, status: "released_to_owner", createdAt },
  });
}

/** Insert a deposit KAEN is HOLDING — the tenant's money, never the owner's. */
async function insertHeldDeposit(amount: string, createdAt: Date) {
  const db = getDb();
  return db.deposit.create({
    data: { organizationId: ORG, tenancyId: TENANCY, partyId: TENANT, unitId: LISTING, type: "security", amount, status: "held", createdAt },
  });
}

const JUN = new Date(Date.UTC(2026, 5, 1));
const JUL = new Date(Date.UTC(2026, 6, 1));
const JUN_MID = new Date(Date.UTC(2026, 5, 15));
// Last calendar day of June, 15:00 MYT = 07:00 UTC — a normal Malaysian
// business-day collection. A midnight-of-last-day bound (the M-C1 bug) is
// `2026-06-30T00:00:00Z`, so this deposit is `> that bound` and was wrongly
// pushed into July.
const JUN_LAST_BIZ = new Date(Date.UTC(2026, 5, 30, 7, 0, 0));

dn("owner-ledger deposit-aware settlement (C3/C4: G5 + G6 + close-out)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedOrg();
  });
  afterAll(async () => {
    await cleanup();
  });

  // ── G5 ──────────────────────────────────────────────────────────────────────
  it("G5: /months returns the real deposit for a month with collected deposits (matches assembleYannieStatement)", async () => {
    const db = getDb();
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertDeposit("2080.00", JUN_MID);

    // owner_statement Invoice so assembleYannieStatement can assemble the same month.
    const invoice = await db.invoice.create({
      data: { organizationId: ORG, invoiceNumber: "STL-OS-2026-06", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: JUN, periodMonth: JUN, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:2026-06` },
    });

    const months = await getOwnerMonthsService(ctx, OWNER);
    expect(months.ok).toBe(true);
    if (!months.ok) return;
    const jun = months.data.items.find((m) => m.month === "2026-06");
    expect(jun).toBeDefined();
    expect(jun!.depositCollected).toBe("2080.00");

    // Cross-check: the statement assembler reports the SAME deposit (shared source).
    const s = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, invoice.id);
    expect(s).not.toBeNull();
    expect(s!.payoutSummary.depositCollected).toBe("2080.00");
    expect(jun!.depositCollected).toBe(s!.payoutSummary.depositCollected);
  });

  // ── The money gate: a HELD deposit is not the owner's ───────────────────────
  it("a deposit KAEN is HOLDING contributes nothing to the owner's collected deposit or payout", async () => {
    // The whole point of the 2026-08-18 change. A held deposit is the tenant's
    // money, refundable at move-out. If it leaked into depositCollected it would
    // flow to grossCashIn and KAEN would overpay the owner by their tenants'
    // deposits — with nothing on the statement to notice it.
    const db = getDb();
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertHeldDeposit("2080.00", JUN_MID);

    const invoice = await db.invoice.create({
      data: { organizationId: ORG, invoiceNumber: "STL-OS-2026-06-HELD", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: JUN, periodMonth: JUN, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:2026-06` },
    });

    const months = await getOwnerMonthsService(ctx, OWNER);
    expect(months.ok).toBe(true);
    if (!months.ok) return;
    const jun = months.data.items.find((m) => m.month === "2026-06");
    expect(jun!.depositCollected).toBe("0.00");

    const s = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, invoice.id);
    expect(s).not.toBeNull();
    expect(s!.payoutSummary.depositCollected).toBe("0.00");

    // At the repository seam: the payout reader ignores it, the balance reader
    // sees it. Both halves of the split, asserted where they are decided.
    const monthEnd = depositWindowEndOfMonth(JUN);
    expect(await findDepositsCollectedInMonth(ORG, [LISTING], JUN, monthEnd)).toEqual([]);
    expect(await findDepositsHeldForUnits(ORG, [LISTING])).toEqual([
      { unitId: LISTING, type: "security", amount: "2080.00" },
    ]);
  });

  it("a RELEASED deposit is the owner's, a HELD one is not — same unit, same month", async () => {
    await insertDeposit("500.00", JUN_MID);
    await insertHeldDeposit("2080.00", JUN_MID);

    const monthEnd = depositWindowEndOfMonth(JUN);
    // Only the released one is owner cash-in...
    expect(await findDepositsCollectedInMonth(ORG, [LISTING], JUN, monthEnd)).toEqual([
      { unitId: LISTING, type: "security", amount: "500.00" },
    ]);
    // ...and only the held one is a KAEN-held balance.
    expect(await findDepositsHeldForUnits(ORG, [LISTING])).toEqual([
      { unitId: LISTING, type: "security", amount: "2080.00" },
    ]);
  });

  it("findDepositsHeldForUnits short-circuits on an empty unit list", async () => {
    await insertHeldDeposit("2080.00", JUN_MID);
    expect(await findDepositsHeldForUnits(ORG, [])).toEqual([]);
  });

  // THE money gate. Every payout figure must be byte-identical whether or not
  // KAEN is holding a deposit. If this drifts, owners are being paid their
  // tenants' deposits.
  it("holding a deposit moves NO payout figure, and shows as a memo line", async () => {
    const db = getDb();
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    // Distinct idempotencyKeys: two statements for one owner-month is not a real
    // scenario, but assembling the same month twice is how this test isolates the
    // held deposit as the ONLY difference between the two runs.
    const mkInvoice = (n: string) =>
      db.invoice.create({
        data: { organizationId: ORG, invoiceNumber: n, partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: JUN, periodMonth: JUN, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:2026-06:${n}` },
      });

    // Baseline: no deposit held at all.
    const before = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, (await mkInvoice("STL-OS-BASE")).id);
    expect(before).not.toBeNull();
    expect(before!.payoutSummary.depositHeld).toBe("0.00");
    expect(before!.payoutSummary.lines.some((l) => l.label === "Deposit held by KAEN")).toBe(false);

    // Now hold RM 4,400 rental + RM 2,200 utilities.
    await insertHeldDeposit("4400.00", JUN_MID);
    await insertHeldDeposit("2200.00", JUN_MID);
    const after = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, (await mkInvoice("STL-OS-HELD2")).id);
    expect(after).not.toBeNull();

    // The memo line appears, carrying the full held balance...
    expect(after!.payoutSummary.depositHeld).toBe("6600.00");
    const memo = after!.payoutSummary.lines.find((l) => l.label === "Deposit held by KAEN");
    expect(memo).toBeDefined();
    expect(memo!.amount).toBe("6600.00");
    expect(memo!.isNonIncome).toBe(true);
    expect(memo!.isTotal).toBeUndefined();

    // ...and not one payout figure moved.
    expect(after!.payoutSummary.netPayoutToOwner).toBe(before!.payoutSummary.netPayoutToOwner);
    expect(after!.payoutSummary.depositCollected).toBe(before!.payoutSummary.depositCollected);
    const totalOf = (s: typeof after) => s!.payoutSummary.lines.find((l) => l.isTotal)?.amount;
    expect(totalOf(after)).toBe(totalOf(before));
    const grossOf = (s: typeof after) => s!.payoutSummary.lines.find((l) => l.label === "Gross Cash In")?.amount;
    expect(grossOf(after)).toBe(grossOf(before));
  });

  it("a held deposit still shows on a LATER month's statement — it is a balance, not an event", async () => {
    const db = getDb();
    await insertHeldDeposit("4400.00", JUN_MID); // collected in June
    await insertEntry({ statementMonth: JUL, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    const julInvoice = await db.invoice.create({
      data: { organizationId: ORG, invoiceNumber: "STL-OS-2026-07-HELD", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: JUL, periodMonth: JUL, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:2026-07` },
    });

    const jul = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, julInvoice.id);
    expect(jul).not.toBeNull();
    // No date window on the held query, so July sees June's still-held deposit.
    expect(jul!.payoutSummary.depositHeld).toBe("4400.00");
    // But July's collected deposit is still zero — held is not cash-in.
    expect(jul!.payoutSummary.depositCollected).toBe("0.00");
  });

  // ── G6 ──────────────────────────────────────────────────────────────────────
  it("G6: resolveOwnerBalance threads the deposit so carried-forward reconciles WITH it (two months)", async () => {
    // Month 1 (Jun): income 1000, deductible expense 200, deposit 2,080.
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUN, direction: "expense", category: "management_fee", amount: "200.00", includeInPayout: true });
    await insertDeposit("2080.00", JUN_MID);
    // Month 2 (Jul): income 800, deductible expense 100, NO deposit.
    await insertEntry({ statementMonth: JUL, direction: "income", category: "rental_income", amount: "800.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUL, direction: "expense", category: "management_fee", amount: "100.00", includeInPayout: true });

    // Whole window [Jun, Jul].
    const both = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-07");
    expect(both.broughtForward).toBe("0.00");
    expect(both.periodGross).toBe("1800.00");
    expect(both.periodExpenses).toBe("300.00");
    expect(both.depositCollected).toBe("2080.00");
    // netThisPeriod = (1800 − 300) + 2080 = 3580.
    expect(both.netThisPeriod).toBe("3580.00");
    // carriedForward = Σ(income − deductible expense + deposit) − Σ payouts.
    expect(both.carriedForward).toBe("3580.00");
    // Partition identity holds WITH the deposit.
    expect(
      cents(both.broughtForward) + cents(both.netThisPeriod) - cents(both.periodPayouts),
    ).toBe(cents(both.carriedForward));

    // Jul-only: the deposit collected in Jun must be CARRIED into broughtForward.
    const jul = await resolveOwnerBalance(ORG, OWNER, "2026-07", "2026-07");
    // broughtForward = Jun deposit-aware net = (1000 − 200) + 2080 = 2880.
    expect(jul.broughtForward).toBe("2880.00");
    expect(jul.depositCollected).toBe("0.00"); // none collected in Jul
    expect(jul.netThisPeriod).toBe("700.00");
    expect(jul.carriedForward).toBe("3580.00");
    expect(cents(jul.broughtForward) + cents(jul.netThisPeriod) - cents(jul.periodPayouts)).toBe(cents(jul.carriedForward));
  });

  // ── C4: record payout zeroes the deposit-aware balance ───────────────────────
  it("C4: recording owner_payout for the full deposit-aware net returns the balance to 0", async () => {
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUN, direction: "expense", category: "management_fee", amount: "200.00", includeInPayout: true });
    await insertDeposit("2080.00", JUN_MID);

    const before = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    // Net incl. deposit = 1000 − 200 + 2080 = 2880.
    expect(before.carriedForward).toBe("2880.00");

    // KAEN remits the full deposit-aware net via the EXISTING Record-Payout flow.
    const payout = await createEntryService(ctx, {
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      statementMonth: "2026-06",
      transactionDate: "2026-06-28",
      direction: "payout",
      category: "owner_payout",
      amount: before.carriedForward,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      attachmentKeys: [],
    });
    expect(payout.ok).toBe(true);

    const after = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    expect(after.periodPayouts).toBe("2880.00");
    expect(after.carriedForward).toBe("0.00");

    // getSummaryService surfaces the same deposit-aware close-out.
    const summary = await getSummaryService(ctx, { ownerPartyId: OWNER, fromMonth: "2026-06", toMonth: "2026-06" });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.data.carriedForward).toBe("0.00");
    expect(summary.data.depositCollected).toBe("2080.00");
  });

  // ── C4: negative month carries forward; next month nets against it ───────────
  it("C4: a negative month (KAEN fronted) carries forward and next month nets against it", async () => {
    // Jun: income 100, deductible expense 500 → net −400 (KAEN fronted 400). No deposit.
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "100.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUN, direction: "expense", category: "management_fee", amount: "500.00", includeInPayout: true });
    // Jul: income 1000, deductible expense 100 → net +900.
    await insertEntry({ statementMonth: JUL, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUL, direction: "expense", category: "management_fee", amount: "100.00", includeInPayout: true });

    const jul = await resolveOwnerBalance(ORG, OWNER, "2026-07", "2026-07");
    expect(jul.broughtForward).toBe("-400.00"); // KAEN fronted in Jun
    expect(jul.netThisPeriod).toBe("900.00");
    // Next month nets against the fronted amount: −400 + 900 = 500.
    expect(jul.carriedForward).toBe("500.00");
  });

  // ── §11.5 net-out close-out identity ────────────────────────────────────────
  // Ported from the deleted owner-billing.per-unit-reconciliation.integration.test.ts.
  // The block tested owner-ledger close-out (NOT per-unit generation), so it
  // survives the combined-only redesign.  Key invariants:
  //   (a) payout.includeInPayout === false — payout entries never re-enter the net
  //   (b) netThisPeriod is UNCHANGED after the payout (payouts tracked separately)
  //   (c) broughtForward + netThisPeriod − periodPayouts == carriedForward (identity)
  //   (d) carriedForward → 0 after ONE payout == netThisPeriod
  it("§11.5 net-out: payout == netThisPeriod drives carriedForward to 0; identity and netThisPeriod stability hold", async () => {
    // Simple ledger: income 2000, deductible management fee 200 → net 1800. No deposit.
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "2000.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUN, direction: "expense", category: "management_fee", amount: "200.00", includeInPayout: true });

    type Balance = Awaited<ReturnType<typeof resolveOwnerBalance>>;
    const idC = (b: Balance) =>
      cents(b.broughtForward) + cents(b.netThisPeriod) - cents(b.periodPayouts);

    const before = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    // Identity holds BEFORE any payout (periodPayouts = 0).
    expect(cents(before.periodPayouts)).toBe(0);
    expect(idC(before)).toBe(cents(before.carriedForward));
    // No prior months → broughtForward 0, carriedForward == netThisPeriod.
    expect(cents(before.broughtForward)).toBe(0);
    expect(cents(before.netThisPeriod)).toBeGreaterThan(0);
    expect(cents(before.carriedForward)).toBe(cents(before.netThisPeriod));
    // Sanity: net = 2000 − 200 = 1800.
    expect(before.netThisPeriod).toBe("1800.00");

    // Record ONE payout for the FULL net.
    const payout = await createEntryService(ctx, {
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      statementMonth: "2026-06",
      transactionDate: "2026-06-28",
      direction: "payout",
      category: "owner_payout",
      amount: before.netThisPeriod,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      attachmentKeys: [],
    });
    expect(payout.ok).toBe(true);
    if (!payout.ok) return;
    // (a) Payout entries never re-enter the net.
    expect(payout.data.includeInPayout).toBe(false);

    const after = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    // (b) netThisPeriod is unchanged — payouts are tracked SEPARATELY.
    expect(cents(after.netThisPeriod)).toBe(cents(before.netThisPeriod));
    // (c) Identity still holds after the payout.
    expect(idC(after)).toBe(cents(after.carriedForward));
    // (d) The month is SETTLED.
    expect(after.periodPayouts).toBe("1800.00");
    expect(cents(after.carriedForward)).toBe(0);
  });

  // ── M-C1: last-day deposit attributes to the month it was collected ──────────
  it("M-C1: a deposit created on June's LAST day at 15:00 MYT (07:00 UTC) attributes to JUNE on every surface — findDepositsCollectedInMonth, statement, /months, balance — not July", async () => {
    const db = getDb();
    // June ledger income so the month surfaces on the /months card.
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    // The deposit collected on the LAST calendar day of June, during business hours.
    await insertDeposit("500.00", JUN_LAST_BIZ);

    // owner_statement Invoice for June so assembleYannieStatement can assemble it.
    const junInvoice = await db.invoice.create({
      data: { organizationId: ORG, invoiceNumber: "STL-OS-2026-06-LD", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: JUN, periodMonth: JUN, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:2026-06` },
    });

    // (1) findDepositsCollectedInMonth — the shared window fn with the shared
    // end-of-day-inclusive upper bound — counts it in June and NOT July.
    const junDeposits = await findDepositsCollectedInMonth(ORG, [LISTING], JUN, depositWindowEndOfMonth(JUN));
    expect(junDeposits.reduce((a, r) => a + cents(r.amount), 0)).toBe(50000);
    const julDeposits = await findDepositsCollectedInMonth(ORG, [LISTING], JUL, depositWindowEndOfMonth(JUL));
    expect(julDeposits).toHaveLength(0);

    // (2) statement
    const s = await assembleYannieStatement({ orgId: ORG, actorUserId: USER, actorRole: "admin" }, junInvoice.id);
    expect(s).not.toBeNull();
    expect(s!.payoutSummary.depositCollected).toBe("500.00");

    // (3) /months card
    const months = await getOwnerMonthsService(ctx, OWNER);
    expect(months.ok).toBe(true);
    if (!months.ok) return;
    const junCard = months.data.items.find((m) => m.month === "2026-06");
    expect(junCard).toBeDefined();
    expect(junCard!.depositCollected).toBe("500.00");

    // (4) running balance — June counts it; July does NOT (no mis-attribution).
    const junBal = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    expect(junBal.depositCollected).toBe("500.00");
    const julBal = await resolveOwnerBalance(ORG, OWNER, "2026-07", "2026-07");
    expect(julBal.depositCollected).toBe("0.00");

    // All four surfaces agree by construction (one shared window + helper).
    expect(s!.payoutSummary.depositCollected).toBe(junCard!.depositCollected);
    expect(junCard!.depositCollected).toBe(junBal.depositCollected);
  });

  // ── M-C1: two-month brought==carried reconciliation with a last-day deposit ──
  it("M-C1: carriedForward(June) === broughtForward(July) with a last-day-of-June deposit (no longer off by the deposit)", async () => {
    // June: income 1000, deductible expense 200, deposit 500 on the LAST day.
    await insertEntry({ statementMonth: JUN, direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUN, direction: "expense", category: "management_fee", amount: "200.00", includeInPayout: true });
    await insertDeposit("500.00", JUN_LAST_BIZ);
    // July: income 800, deductible expense 100, NO deposit.
    await insertEntry({ statementMonth: JUL, direction: "income", category: "rental_income", amount: "800.00", includeInPayout: false });
    await insertEntry({ statementMonth: JUL, direction: "expense", category: "management_fee", amount: "100.00", includeInPayout: true });

    // June: the last-day deposit lands in June's PERIOD (and so its carry-forward).
    const junBal = await resolveOwnerBalance(ORG, OWNER, "2026-06", "2026-06");
    expect(junBal.depositCollected).toBe("500.00");
    // carried = (1000 − 200) + 500 = 1300.
    expect(junBal.carriedForward).toBe("1300.00");

    // July: the SAME deposit is in July's brought-forward — counted once, the seam tiles.
    const julBal = await resolveOwnerBalance(ORG, OWNER, "2026-07", "2026-07");
    expect(julBal.broughtForward).toBe("1300.00");
    expect(julBal.depositCollected).toBe("0.00");

    // THE reconciliation: no gap, no overlap, no off-by-the-deposit.
    expect(junBal.carriedForward).toBe(julBal.broughtForward);

    // Close-out identity still holds across the month seam.
    expect(julBal.carriedForward).toBe("2000.00"); // 1300 + (800 − 100)
    expect(
      cents(julBal.broughtForward) + cents(julBal.netThisPeriod) - cents(julBal.periodPayouts),
    ).toBe(cents(julBal.carriedForward));
  });
});

function cents(s: string): number {
  return Math.round(parseFloat(s) * 100);
}
