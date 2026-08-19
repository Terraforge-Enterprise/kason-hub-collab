/**
 * Task 7 — freeze-aware sync guard + FORWARD reversal (integration,
 * RUN_INTEGRATION=1). The HIGHEST-RISK slice: money + the shared owner-ledger
 * sync engine that re-runs on EVERY payment/void.
 *
 * Once an owner-statement month is FROZEN (Task 4), its ledger rows are immutable
 * (append-only). A void of a source Charge booked into a frozen month must NOT
 * rebuild the frozen month; instead the correction flows FORWARD as a reversing
 * OwnerLedgerEntry posted into the CURRENT open month.
 *
 * Proves (bank-grade):
 *   1. Immutability + forward reversal — freeze the prior month, void a settled
 *      (paid) source charge booked into it, run the real sync hook →
 *        (a) the frozen OwnerStatementPeriod snapshotJson + closingBalanceC are
 *            byte-identical (untouched);
 *        (b) the frozen month's active OwnerLedgerEntry rows are UNCHANGED (not
 *            rebuilt / not voided);
 *        (c) exactly ONE new OwnerLedgerEntry lands in the CURRENT open month:
 *            opposite direction, same category, sourceType="reversal",
 *            sourceChargeId=<the frozen-month charge>, description /holdback/.
 *   2. Idempotent — invoking the hook a SECOND time yields STILL exactly one
 *      reversal row (upsert on the (org,"reversal",sourceChargeId) unique key).
 *   3. Paid-only — a voided UNPAID frozen-month charge (never entered the
 *      cash-basis snapshot) produces NO reversal.
 *   4. Open-month in place — a current (still-open) charge voided is corrected in
 *      place by the normal sync reverse pass; NO forward reversal row is posted.
 *   5. Freeze guard — a direct re-sync of a frozen month does NOT rebuild its
 *      rows (returns skipped:1, created/updated/reversed:0).
 *
 * Frozen month = the calendar month BEFORE now; current open month = now's month
 * (derived at runtime so the suite is date-independent — the reversal always
 * targets the real current month the service computes).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     ../../node_modules/.bin/vitest run \
 *     src/modules/owner-billing/__tests__/owner-statement-forward-correction.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { syncMonthService, postForwardReversalForFrozenMonth } from "../../owner-ledger/owner-ledger.sync";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";
import { runSourceToLedger } from "../../owner-ledger/reconciliation/source-to-ledger";
import { runFrozenIntegrity } from "../../owner-ledger/reconciliation/frozen-integrity";
import { resolveOwnerBalance } from "../../owner-ledger/owner-ledger.repository";
import { freezeStatementPeriod } from "../owner-statement-period.service";
import type { OwnerLedgerActorCtx } from "../../owner-ledger/owner-ledger.types";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 7f70; unused by any other suite) ───────────────
const ORG = "7f700000-0000-4000-8000-000000000001";
const USER = "7f700000-0000-4000-8000-000000000002";
const OWNER = "7f700000-0000-4000-8000-000000000003";
const TENANT = "7f700000-0000-4000-8000-000000000004";
const PROP = "7f700000-0000-4000-8000-000000000005";
const APT = "7f700000-0000-4000-8000-000000000006";
const UNIT = "7f700000-0000-4000-8000-000000000007";
const TEN = "7f700000-0000-4000-8000-000000000008";
const C_RENT = "7f700000-0000-4000-8000-000000000009";
const C_UNPAID = "7f700000-0000-4000-8000-00000000000a";
const C_CUR = "7f700000-0000-4000-8000-00000000000b";

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ── Runtime-derived months (date-independent) ──────────────────────────────────
// Frozen = the month BEFORE now; current open = now's month. Derived via UTC so
// they mirror EXACTLY what the service computes (curMonth = UTC first-of-month).
const NOW = new Date();
const curStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const ym = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const FROZEN_M = ym(frozenStart);
const CUR_M = ym(curStart);
const frozenDue = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), 5));
const curDue = curStart; // first-of-month is always within the current month range
// Cross-month (frozen-immutability) tests need THREE months: an EARLIER frozen month
// ("Jan" = 2 months ago) that holds the income row, the frozenStart month ("Feb" = last
// month) that holds the — now frozen — forward reversal row, and the current open month.
const janStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 1));
const JAN_M = ym(janStart);
const janDue = new Date(Date.UTC(janStart.getUTCFullYear(), janStart.getUTCMonth(), 5));

// Flags toggled ON for this suite (both required: the hook is gated on
// ENABLE_PHASE2_OWNER_BILLING; the guard + reversal on the live-ledger flag).
let savedBilling: string | undefined;
let savedLedger: string | undefined;

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
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
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "7F70 Forward Correction Org",
      slug: "7f70-forward-correction-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "7f70@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "7F70 Admin" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Fwd Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Fwd Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "Fwd Tower", propertyCode: "FW-P1", propertyType: "apartment", addressLine1: "1 Fwd St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "FW-01-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: {
      id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.tenancy.create({
    data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "FW-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2025, 0, 1)), monthlyRentAmount: "800" },
  });
}

async function makeRentCharge(o: {
  id: string;
  status: string;
  amount: string;
  outstanding: string;
  billingMonth: Date;
  dueDate: Date;
  number: string;
}) {
  return getDb().charge.create({
    data: {
      id: o.id,
      organizationId: ORG,
      chargeNumber: o.number,
      partyId: TENANT,
      tenancyId: TEN,
      unitId: UNIT,
      chargeType: "rent",
      status: o.status,
      postedAt: new Date(),
      dueDate: o.dueDate,
      amount: o.amount,
      currency: "MYR",
      outstandingAmount: o.outstanding,
      billingMonth: o.billingMonth,
    },
  });
}

// ── Payment/allocation event helpers (Bug 2 — double-debit reproduction) ────────
// The allocation `createdAt` is the freeze-boundary discriminator; a reversal is an
// append-only event, independent of any charge-status flip (verified cascade).
let payCounter = 0;
const RECEIVED = new Date(Date.UTC(curStart.getUTCFullYear(), curStart.getUTCMonth(), 10));

async function payCharge(o: { chargeId: string; amount: string; createdAt: Date }): Promise<string> {
  const db = getDb();
  const paymentId = randomUUID();
  await db.payment.create({
    // "posted" is the ONLY status meaning money arrived; "completed" is written
    // nowhere in production (see PAYMENT_STATUSES). This suite drives
    // syncOwnerLedgerForCharges → postPriorPeriodCollections and runSourceToLedger,
    // both of which read cash through CASH_ALLOCATION_WHERE — so a fictional
    // status makes this fixture's money invisible to every reader under test.
    data: { id: paymentId, organizationId: ORG, paymentNumber: `FC-PAY-${++payCounter}`, partyId: TENANT, paymentType: "tenant_payment", paymentMethod: "bank_transfer", status: "posted", amount: o.amount, currency: "MYR", receivedAt: RECEIVED },
  });
  const allocId = randomUUID();
  await db.paymentAllocation.create({
    data: { id: allocId, organizationId: ORG, paymentId, chargeId: o.chargeId, allocatedAmount: o.amount, allocatedAt: RECEIVED, createdAt: o.createdAt },
  });
  return allocId;
}

async function reverseAllocation(o: { allocationId: string; amount: string; createdAt: Date }): Promise<string> {
  const id = randomUUID();
  await getDb().paymentAllocationReversal.create({
    data: { id, organizationId: ORG, originalAllocationId: o.allocationId, amount: o.amount, reason: "bounce", reversedById: USER, createdAt: o.createdAt, idempotencyKey: `FC-REV-${id}` },
  });
  return id;
}

const ppcReversalRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "prior_period_collection_reversal", sourceChargeId: chargeId } });
const forwardReversalRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: chargeId } });
/** Net forward booked for a charge (cents): Σppc − Σppc_reversal − Σreversal. */
async function forwardNetC(chargeId: string): Promise<number> {
  const rows = await getDb().ownerLedgerEntry.findMany({
    where: { organizationId: ORG, sourceChargeId: chargeId, status: "active", sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal", "reversal"] } },
    select: { amount: true, sourceType: true },
  });
  return rows.reduce((s, r) => {
    const c = Math.round(Number(r.amount.toString()) * 100);
    return s + (r.sourceType === "prior_period_collection" ? c : -c);
  }, 0);
}
const ppcRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "prior_period_collection", sourceChargeId: chargeId, status: "active" } });
// The forward-adjustment rows the fix posts into the OPEN month when the write-once
// `reversal` row is frozen (the delta that keeps Σ(reversal-family) == targetC).
const forwardAdjustmentRows = (chargeId: string) =>
  getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal_forward_adjustment", sourceChargeId: chargeId } });
/** Σ over ACTIVE reversal-family rows (reversal + reversal_forward_adjustment), signed in
 *  the holdback direction: for an income charge the reversal is an EXPENSE (+), a give-back
 *  is INCOME (−). Must equal targetC = max(0, frozenC + Σppc − Σppc_reversal). */
async function reversalFamilyC(chargeId: string): Promise<number> {
  const rows = await getDb().ownerLedgerEntry.findMany({
    where: { organizationId: ORG, sourceChargeId: chargeId, status: "active", sourceType: { in: ["reversal", "reversal_forward_adjustment"] } },
    select: { amount: true, direction: true },
  });
  return rows.reduce((s, r) => {
    const c = Math.round(Number(r.amount.toString()) * 100);
    return s + (r.direction === "expense" ? c : -c);
  }, 0);
}
/** Open critical frozen-integrity (R6) findings for the whole org — must be 0 after the fix. */
const openFrozenIntegrityCount = () =>
  getDb().ownerLedgerReconciliationFinding.count({ where: { organizationId: ORG, checkKind: "frozen_integrity", severity: "critical", status: { in: ["open", "acknowledged"] } } });
/** Seed a frozen-month reversal-family row directly (simulates a reversal / forward-adjustment
 *  posted into a month that has since frozen). Does NOT freeze — caller freezes once all the
 *  month's rows are seeded so they land in one write-once manifest. */
async function seedLedgerRow(o: { chargeId: string; month: Date; amount: string; direction: "income" | "expense"; category: string; sourceType: string; sourceAllocationEventId?: string }) {
  await getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, tenancyId: TEN,
      statementMonth: o.month, transactionDate: o.month,
      direction: o.direction, category: o.category, amount: o.amount,
      paidBy: "kaen", paymentStatus: "paid", includeInPayout: true,
      sourceType: o.sourceType, sourceChargeId: o.chargeId, sourceAllocationEventId: o.sourceAllocationEventId ?? null, status: "active",
      createdById: USER, updatedById: USER,
    },
  });
}
/** Seed a frozen-month `reversal` row directly, then freeze that month so the row is captured
 *  in its write-once manifest — the exact post-freeze state the fix must never mutate. */
async function seedFrozenReversal(o: { chargeId: string; month: Date; monthKey: string; amount: string; direction: "income" | "expense"; category: string }) {
  await seedLedgerRow({ chargeId: o.chargeId, month: o.month, amount: o.amount, direction: o.direction, category: o.category, sourceType: "reversal" });
  return freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: o.monthKey });
}
/** Total owner RECOGNISED income for a charge (cents): Σ over ALL active rows
 *  (frozen normal + forward), income(+)/expense(−). A correctly held-back voided
 *  charge nets to 0 — the retained cash is the tenant's credit, not owner income. */
async function ownerIncomeC(chargeId: string): Promise<number> {
  const rows = await getDb().ownerLedgerEntry.findMany({
    where: { organizationId: ORG, sourceChargeId: chargeId, status: "active" },
    select: { amount: true, direction: true },
  });
  return rows.reduce((s, r) => {
    const c = Math.round(Number(r.amount.toString()) * 100);
    return s + (r.direction === "income" ? c : -c);
  }, 0);
}
const s2lOrphanFindings = (chargeId: string) =>
  getDb().ownerLedgerReconciliationFinding.findMany({ where: { organizationId: ORG, checkKind: "source_to_ledger", findingType: "orphaned_forward_collection", sourceId: chargeId } });

dn("owner-statement forward correction — freeze guard + forward reversal (integration)", () => {
  beforeAll(() => {
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
  });
  afterAll(async () => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  // ── 1: immutability of the frozen month + exactly ONE forward reversal ──────────
  it("void of a frozen-month paid charge leaves the frozen month byte-identical and posts ONE reversal in the current open month", async () => {
    const db = getDb();
    // A settled (paid) rent charge booked into the frozen month → materialise it.
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "RENT-FROZEN-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const rentRow = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT },
    });
    expect(rentRow.status).toBe("active");
    expect(rentRow.paymentStatus).toBe("paid");

    // Freeze the month → immutable snapshot.
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const beforeSnap = JSON.stringify(frozen.snapshotJson);
    const beforeClosing = frozen.closingBalanceC;
    expect(frozen.status).toBe("frozen");

    // Void the source charge and run the REAL post-commit sync hook.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    // (a) frozen period snapshot + closing byte-identical.
    const periodAfter = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(JSON.stringify(periodAfter.snapshotJson)).toBe(beforeSnap);
    expect(periodAfter.closingBalanceC).toBe(beforeClosing);

    // (b) frozen month's active rows UNCHANGED (not rebuilt, not voided).
    const rentAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: rentRow.id } });
    expect(rentAfter.status).toBe("active");
    expect(rentAfter.paymentStatus).toBe("paid");
    expect(rentAfter.statementMonth.getTime()).toBe(frozenStart.getTime());
    expect(Number(rentAfter.amount.toString())).toBe(800);

    // (c) exactly ONE reversal, in the current open month, opposite direction.
    const reversals = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal" } });
    expect(reversals.length).toBe(1);
    const rev = reversals[0]!;
    expect(rev.direction).toBe("expense"); // income → expense
    expect(rev.category).toBe("rental_income");
    expect(rev.sourceChargeId).toBe(C_RENT);
    expect(rev.statementMonth.getTime()).toBe(curStart.getTime());
    expect(rev.paymentStatus).toBe("paid");
    expect(rev.status).toBe("active");
    // The forward reversal exists because the charge is now void → owner-payout holdback,
    // the retained cash being the tenant's credit (same code path, clearer wording).
    expect(rev.description).toMatch(/holdback/i);
    expect(Number(rev.amount.toString())).toBe(800);
  });

  // ── 2: idempotent — re-invoking the hook never compounds duplicates ─────────────
  it("re-invoking the sync hook still yields exactly one reversal row (idempotent on the unique key)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "RENT-FROZEN-2" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });

    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]); // second run — must be a no-op

    const reversals = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });
    expect(reversals.length).toBe(1);
  });

  // ── 3: paid-only — a voided UNPAID frozen-month charge produces NO reversal ──────
  it("a voided UNPAID frozen-month charge produces no reversal (never entered the cash-basis snapshot)", async () => {
    const db = getDb();
    // posted + fully outstanding → the frozen-month ledger row is paymentStatus "pending".
    await makeRentCharge({ id: C_UNPAID, status: "posted", amount: "500.00", outstanding: "500.00", billingMonth: frozenStart, dueDate: frozenDue, number: "RENT-FROZEN-UNPAID" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const unpaidRow = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_UNPAID },
    });
    expect(unpaidRow.paymentStatus).not.toBe("paid");

    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await db.charge.update({ where: { id: C_UNPAID }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_UNPAID]);

    const reversals = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal" } });
    expect(reversals.length).toBe(0);
  });

  // ── 4: open-month in place — a current-month void corrects in place, no forward reversal ──
  it("a voided current (still-open) charge is corrected in place by normal sync, with no forward reversal", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_CUR, status: "paid", amount: "300.00", outstanding: "0.00", billingMonth: curStart, dueDate: curDue, number: "RENT-CUR-1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: CUR_M });
    const curRow = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_CUR },
    });
    expect(curRow.status).toBe("active");

    // The current month is NOT frozen → normal sync reverse pass voids the row in place.
    await db.charge.update({ where: { id: C_CUR }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_CUR]);

    const curAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: curRow.id } });
    expect(curAfter.status).toBe("void"); // corrected in place
    const reversals = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal" } });
    expect(reversals.length).toBe(0); // no forward reversal for an open month
  });

  // ── 5: freeze guard — a direct re-sync of a frozen month does NOT rebuild its rows ──
  it("re-syncing a frozen month skips the rebuild (skipped:1) and leaves rows untouched", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "RENT-FROZEN-GUARD" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const rentRow = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT },
    });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    const r = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ created: 0, updated: 0, skipped: 1, reversed: 0 });

    const rentAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: rentRow.id } });
    expect(rentAfter.status).toBe("active");
    expect(Number(rentAfter.amount.toString())).toBe(800);
  });

  // ── F1 (Bug 2 — CONFIRMED DOUBLE-DEBIT): paid-before-freeze charge, payment reversed ─
  // while the charge is still LIVE (posts a prior_period_collection_reversal that claws
  // back the frozen income), THEN voided. The forward reversal must NET against the
  // already-posted collection-reversal (frozen_collected − Σppc_reversal) and post
  // NOTHING — the pre-fix code reversed the frozen 800 a SECOND time (net −1600).
  it("F1 (Bug 2): payment reversed while live then voided reverses the frozen income EXACTLY ONCE (no double-debit)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-BUG2" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: frozenDue }); // pre-freeze cash → in the frozen figure
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // (1) Payment reversed while the charge stays LIVE (posted) → ppc_reversal −800.
    await reverseAllocation({ allocationId: allocId, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "posted", outstandingAmount: "800.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    expect(await ppcReversalRows(C_RENT)).toHaveLength(1);

    // (2) LATER voided → forward reversal nets to 0 (800 − 800) → posts nothing.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await forwardReversalRows(C_RENT)).toHaveLength(0); // no SECOND reversal
    expect(await forwardNetC(C_RENT)).toBe(-80000); // frozen +800 reversed exactly once
    // Frozen month itself is untouched (immutable).
    const rentFrozen = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(rentFrozen.statementMonth.getTime()).toBe(frozenStart.getTime());
    expect(Number(rentFrozen.amount.toString())).toBe(800);
  });

  // ── F5 (adversarial review, Finding 1/3 — void-THEN-bounce write-once reversal): a ───
  // paid-at-freeze charge VOIDED first posts a FULL forward reversal; when its payment
  // then BOUNCES (a post-freeze PaymentAllocationReversal → prior_period_collection_
  // reversal), the frozen income is reversed TWICE — and the write-once `reversal` row
  // (createMany skipDuplicates) could never be reduced, so the double-debit was permanent
  // (Finding 3: not self-healing). The forward reversal must RECONCILE to
  // max(0, frozen − Σppc_reversal) on EVERY fire, voiding a now-stale full reversal.
  it("F5 (Finding 1/3): a paid charge voided BEFORE its payment bounces self-heals the write-once forward reversal (frozen reversed exactly once)", async () => {
    const db = getDb();
    // Fully paid before freeze → frozen row 800 PAID (postForwardReversal's gate).
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-F5" });
    const alloc1 = await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: frozenDue }); // pre-freeze cash
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // (1) VOID FIRST → posts a FULL reversal (−800): no ppc_reversal exists yet.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    expect((await forwardReversalRows(C_RENT)).filter((r) => r.status === "active")).toHaveLength(1); // stale full reversal

    // (2) THEN the payment bounces → ppc_reversal −800. The stale full reversal must now
    // self-heal to 0 (voided) — else the frozen 800 is reversed TWICE (booked −1600).
    await reverseAllocation({ allocationId: alloc1, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void", outstandingAmount: "800.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await ppcReversalRows(C_RENT)).toHaveLength(1); // the bounce is booked
    expect((await forwardReversalRows(C_RENT)).filter((r) => r.status === "active")).toHaveLength(0); // stale reversal self-healed away
    expect(await forwardNetC(C_RENT)).toBe(-80000); // frozen +800 reversed EXACTLY once (not −1600)
    // Idempotent: a further fire keeps it healed.
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    expect(await forwardNetC(C_RENT)).toBe(-80000);
  });

  // ── F2 (ordering — same hook fire): both the payment-reversal AND the void land ─────
  // BEFORE ONE hook fire. postPriorPeriodCollections MUST run before
  // postForwardReversalForFrozenMonth so the forward-reversal's netting sees the
  // just-posted collection-reversal. Wrong order (reversal first) reverses the full
  // frozen 800, then the collection-reversal adds another −800 → double-debit.
  it("F2 (ordering): payment-reversal AND void before one hook fire net to exactly −frozen once", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-ORDER" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // BOTH events exist before the hook fires even once.
    await reverseAllocation({ allocationId: allocId, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void", outstandingAmount: "800.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await ppcReversalRows(C_RENT)).toHaveLength(1); // collection-reversal posted
    expect(await forwardReversalRows(C_RENT)).toHaveLength(0); // netted to 0 → nothing
    expect(await forwardNetC(C_RENT)).toBe(-80000); // exactly once
  });

  // ── F4 (partial): a post-freeze PARTIAL reversal (300) then void reverses frozen 800 ─
  // exactly once — ppc_reversal 300 (event) + forward reversal 500 (800 − 300 netted).
  it("F4 (partial): partial post-freeze reversal then void reverses the frozen income once (300 + 500)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-PART" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    await reverseAllocation({ allocationId: allocId, amount: "300.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "300.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    const ppcRev = await ppcReversalRows(C_RENT);
    expect(ppcRev).toHaveLength(1);
    expect(Number(ppcRev[0]!.amount.toString())).toBe(300);
    const fRev = await forwardReversalRows(C_RENT);
    expect(fRev).toHaveLength(1);
    expect(Number(fRev[0]!.amount.toString())).toBe(500); // 800 − 300 already reversed
    expect(await forwardNetC(C_RENT)).toBe(-80000); // frozen 800 reversed exactly once
  });

  // ── Case B primary (THE confirmed bug): a charge UNPAID at freeze (frozen normal row
  // pending, collected 0), paid IN FULL after freeze (prior_period_collection +800), then
  // VOIDED with NO refund. Pre-fix, postForwardReversalForFrozenMonth's `originals` query
  // filtered paymentStatus:"paid" → the pending frozen row was skipped → the +800 stood
  // unreversed → owner OVER-credited 800 while the tenant is ALSO owed 800 (credit note).
  // The holdback rule: owner income for a void charge nets to ZERO across pre- AND
  // post-freeze cash — post one reversal of frozenC + Σppc − Σppc_reversal.
  it("Case B: unpaid-at-freeze then paid-after-freeze then voided nets owner income to 0 (holdback reversal 800)", async () => {
    const db = getDb();
    // Unpaid at freeze → frozen normal row collected 0, paymentStatus "pending".
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-CASEB" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(normal.amount.toString())).toBe(0);
    expect(normal.paymentStatus).not.toBe("paid");
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Paid IN FULL after the freeze (post-freeze allocation → prior_period_collection +800) …
    await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    expect(await ppcRows(C_RENT)).toHaveLength(1); // the post-freeze cash was forwarded

    // … then VOIDED with no refund.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    // Owner recognised income nets to ZERO (the retained cash is the tenant's credit).
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    // Exactly one holdback reversal of 800 (the post-freeze collection clawed back).
    const rev = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(Number(rev[0]!.amount.toString())).toBe(800);
    expect(rev[0]!.direction).toBe("expense");
    expect(await forwardNetC(C_RENT)).toBe(0); // +800 ppc − 800 reversal
    // The ppc row (tenant's realized cash) is untouched — only the owner recognition is reversed.
    expect(await ppcRows(C_RENT)).toHaveLength(1);

    // R5 reconciliation is CLEAN for the correctly held-back void.
    await runSourceToLedger(ledgerCtx, {});
    expect(await s2lOrphanFindings(C_RENT)).toHaveLength(0);
  });

  // ── Case B partial: 300 collected pre-freeze (frozen paid 300) + 500 post-freeze
  // (prior_period_collection 500) → void → holdback reversal = 300 + 500 = 800 → income 0.
  it("Case B partial: split pre/post-freeze collection then voided nets owner income to 0 (reversal 300+500)", async () => {
    const db = getDb();
    // 300 collected before freeze → frozen normal row 300 (partial).
    await makeRentCharge({ id: C_RENT, status: "partially_paid", amount: "800.00", outstanding: "500.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-CASEB-PART" });
    await payCharge({ chargeId: C_RENT, amount: "300.00", createdAt: frozenDue }); // pre-freeze cash
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(normal.amount.toString())).toBe(300);
    expect(normal.paymentStatus).not.toBe("paid");
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // 500 collected after freeze → prior_period_collection 500.
    await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    // Voided.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    const rev = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(Number(rev[0]!.amount.toString())).toBe(800); // frozen 300 + ppc 500
    expect(await ownerIncomeC(C_RENT)).toBe(0);
  });

  // ── Reroute/refund: unpaid at freeze → pay 800 after freeze (ppc +800) → PARTIAL refund
  // 300 after freeze (real PaymentAllocationReversal → prior_period_collection_reversal −300)
  // → void. The holdback nets ppc_reversal (no double reversal): reversal = 800 − 300 = 500,
  // owner income 0, and the retained 500 is the tenant's credit. Pre-fix the pending frozen
  // row was skipped → owner kept the retained 500.
  it("reroute/refund: post-freeze collection with a partial refund then voided nets to 0 via ppc_reversal (no double reversal)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-CASEB-REROUTE" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    const allocId = await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]); // ppc +800
    // Partial refund of 300 (real allocation reversal event).
    await reverseAllocation({ allocationId: allocId, amount: "300.00", createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "partially_paid", outstandingAmount: "300.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]); // ppc_reversal −300
    // Voided.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await ppcReversalRows(C_RENT)).toHaveLength(1);
    const rev = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(Number(rev[0]!.amount.toString())).toBe(500); // 0 frozen + 800 ppc − 300 ppc_reversal
    expect(await ownerIncomeC(C_RENT)).toBe(0); // no double reversal
  });

  // ── Case A regression (byte-identical, ppcC = 0): paid at freeze, no post-freeze cash,
  // voided → reverses the full frozen collected EXACTLY once. With no prior_period_collection
  // the holdback target is frozenC + 0 − 0 = frozenC — identical to the prior contract.
  it("Case A: paid-at-freeze charge voided reverses exactly frozenC once (no ppc rows → byte-identical path)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "800.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-CASEA" });
    await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: frozenDue }); // pre-freeze cash only
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await ppcRows(C_RENT)).toHaveLength(0); // ppcC = 0 (no post-freeze cash)
    const rev = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(Number(rev[0]!.amount.toString())).toBe(800); // exactly frozenC
    expect(await ownerIncomeC(C_RENT)).toBe(0);
  });

  // ── Idempotency / double-fire (Case B self-heal): the new +ppcC holdback is write-once on
  // the (org,"reversal",sourceChargeId) partial-unique index — firing the hook repeatedly
  // yields EXACTLY ONE reversal at the correct amount, never compounding.
  it("Case B idempotency: firing the sync hook repeatedly yields exactly one holdback reversal at 800", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-CASEB-IDEM" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void", outstandingAmount: "800.00" } });

    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]); // three fires

    const rev = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(Number(rev[0]!.amount.toString())).toBe(800);
    expect(await ownerIncomeC(C_RENT)).toBe(0);
  });

  // ── Non-void income (only void/credited charges are held back): a LIVE charge that
  // collects cash post-freeze recognises that cash as owner income — NO holdback reversal.
  it("non-void charge with post-freeze collection is not held back (owner recognises the income)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: frozenStart, dueDate: frozenDue, number: "FC-LIVE" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    // Paid after freeze — charge stays LIVE (paid, not void).
    await payCharge({ chargeId: C_RENT, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { status: "paid", outstandingAmount: "0.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await ppcRows(C_RENT)).toHaveLength(1); // income recognised
    expect((await forwardReversalRows(C_RENT)).filter((r) => r.status === "active")).toHaveLength(0); // NOT held back
    expect(await ownerIncomeC(C_RENT)).toBe(80000); // frozen 0 + ppc 800 — the owner earns it
  });

  // ── Dropped-filter blast radius (EXPENSE side): a voided management_fee EXPENSE booked
  // as a PENDING frozen row was, pre-fix, skipped by the paymentStatus:"paid" filter — so
  // the owner permanently bore a voided fee (latent under-credit, since resolveOwnerBalance
  // counts unpaid-active expenses in the payout). Dropping the filter now reverses it
  // FORWARD (expense → income, full amount), netting the owner's true payout to 0. ppcC=0
  // (an owner fee has no tenant allocations), so the holdback target is exactly frozenC.
  it("voided PENDING management_fee expense in a frozen month is reversed forward, netting the owner payout to 0", async () => {
    const db = getDb();
    const C_FEE = randomUUID();
    // A management_fee CHARGE, voided at source.
    await db.charge.create({
      data: { id: C_FEE, organizationId: ORG, chargeNumber: "FC-FEE", partyId: OWNER, unitId: UNIT, chargeType: "management_fee", status: "void", postedAt: new Date(), dueDate: frozenDue, amount: "108.00", currency: "MYR", outstandingAmount: "108.00", billingMonth: frozenStart },
    });
    // Its frozen-month statement EXPENSE row — PENDING (never settled), full 108 booked.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: frozenStart, transactionDate: frozenStart, direction: "expense", category: "management_fee", amount: "108.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true, sourceType: "statement", sourceChargeId: C_FEE, status: "active", createdById: USER, updatedById: USER },
    });
    // Baseline payout: the owner is docked 108 (resolveOwnerBalance counts the unpaid expense).
    const before = await resolveOwnerBalance(ORG, OWNER);
    expect(before.carriedForward).toBe("-108.00");

    await postForwardReversalForFrozenMonth(ledgerCtx, OWNER, FROZEN_M);

    // Exactly one forward reversal: expense → income, full 108, into the current month.
    const rev = (await forwardReversalRows(C_FEE)).filter((r) => r.status === "active");
    expect(rev).toHaveLength(1);
    expect(rev[0]!.direction).toBe("income");
    expect(Number(rev[0]!.amount.toString())).toBe(108);
    expect(rev[0]!.statementMonth.getTime()).toBe(curStart.getTime());
    // The owner's true payout (all active rows, any paymentStatus) now nets to 0.
    const after = await resolveOwnerBalance(ORG, OWNER);
    expect(after.carriedForward).toBe("0.00");
    expect(await ownerIncomeC(C_FEE)).toBe(0);
  });

  // ═══ Cross-month frozen-immutability (review self-heal) ══════════════════════════
  // The write-once `reversal` row is reconciled to targetC on EVERY fire. When that row
  // has since FROZEN (its month is a frozen statement period), the in-place update/void
  // MUTATES a manifest-snapshotted, PDF-issued row — breaching frozen immutability and
  // tripping R6. The correction must instead post the DELTA FORWARD into the current open
  // month so Σ(reversal-family) == targetC while every frozen row stays byte-identical.

  // ── XM primary (CONFIRMED breach): Jan rent 500 collected pre-freeze (Jan frozen);
  //    voided → reversal 500 into Feb; Feb freezes; Mar a 200 cheque bounces
  //    (PaymentAllocationReversal) → ppc_reversal −200 → targetC = max(0,500−200) = 300.
  //    The frozen Feb reversal MUST stay 500; the −200 lands in the OPEN month; R6 clean.
  it("XM primary: a bounce after a SECOND freeze corrects forward — the frozen reversal row is NEVER mutated (R6 clean)", async () => {
    const db = getDb();

    // Jan (2 months ago): rent 500 fully collected BEFORE Jan freeze → income 500, frozen.
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "500.00", outstanding: "0.00", billingMonth: janStart, dueDate: janDue, number: "XM-RENT" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: janDue }); // pre-Jan-freeze cash
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: JAN_M });
    const janFrozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JAN_M });
    const janFrozenAt = janFrozen.firstFrozenAt as Date;
    const rentRow = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(rentRow.amount.toString())).toBe(500);

    // The charge is voided (during Feb — the then-open month).
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });

    // Feb (last month): the forward reversal (expense 500) was posted here; then Feb froze.
    await seedFrozenReversal({ chargeId: C_RENT, month: frozenStart, monthKey: FROZEN_M, amount: "500.00", direction: "expense", category: "rental_income" });
    const febReversal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });
    const before = { id: febReversal.id, amountC: Math.round(Number(febReversal.amount.toString()) * 100), status: febReversal.status, updatedAt: febReversal.updatedAt.getTime(), month: febReversal.statementMonth.getTime() };
    expect(before.amountC).toBe(50000);

    // Mar (now): a 200 cheque bounces — a real post-Jan-freeze PaymentAllocationReversal.
    await reverseAllocation({ allocationId: allocId, amount: "200.00", createdAt: new Date(janFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { outstandingAmount: "200.00" } }); // still void

    // Fire the REAL post-commit hook (charge billingMonth = Jan → frozen branch).
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    // (a) the frozen Feb reversal row is BYTE-IDENTICAL (never mutated: amount/status/month/updatedAt).
    const after = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: before.id } });
    expect(Math.round(Number(after.amount.toString()) * 100)).toBe(50000); // still 500 — NOT recomputed to 300
    expect(after.status).toBe("active");
    expect(after.statementMonth.getTime()).toBe(before.month);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt); // no write touched the frozen row

    // (b) the −200 correction landed in the OPEN month as a reversal_forward_adjustment.
    const adj = await forwardAdjustmentRows(C_RENT);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.statementMonth.getTime()).toBe(curStart.getTime());
    expect(adj[0]!.direction).toBe("income"); // give-back (opposite the expense reversal)
    expect(Number(adj[0]!.amount.toString())).toBe(200);
    expect(adj[0]!.status).toBe("active");

    // (c) Σ(reversal-family, signed) == 300 == max(0, 500 + 0 − 200).
    expect(await reversalFamilyC(C_RENT)).toBe(30000);

    // (d) owner all-time recognised income nets to 0 (void charge → tenant credit).
    expect(await ownerIncomeC(C_RENT)).toBe(0);

    // (e) R6 frozen-integrity reports ZERO drift (the frozen Feb reversal is untouched).
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await openFrozenIntegrityCount()).toBe(0);

    // (f) R5 source-to-ledger stays clean (direction-aware reversal-family sum).
    await runSourceToLedger(ledgerCtx, {});
    expect(await s2lOrphanFindings(C_RENT)).toHaveLength(0);
  });

  // ── XM same-open-month (byte-identical guard): when the `reversal` row's month is STILL
  //    OPEN, a later bounce reconciles it IN PLACE — the frozen-gate must NOT divert the
  //    correction into a forward-adjustment. Reversal in the open month → one row, no adjustment.
  it("XM same-open-month: a bounce while the reversal month is OPEN updates the reversal in place (no forward-adjustment)", async () => {
    const db = getDb();
    // Rent 500 paid before the (last-month) freeze → frozen income 500.
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "500.00", outstanding: "0.00", billingMonth: frozenStart, dueDate: frozenDue, number: "XM-OPEN" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: frozenDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Void → reversal 500 posts into the CURRENT open month (curStart, never frozen here).
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    const revOpen = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(revOpen).toHaveLength(1);
    expect(revOpen[0]!.statementMonth.getTime()).toBe(curStart.getTime());

    // A 200 bounce → targetC = 300. The reversal is in the OPEN month → updated IN PLACE.
    await reverseAllocation({ allocationId: allocId, amount: "200.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    const revAfter = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(revAfter).toHaveLength(1); // still the SAME single reversal row
    expect(revAfter[0]!.id).toBe(revOpen[0]!.id); // updated in place, not replaced
    expect(Number(revAfter[0]!.amount.toString())).toBe(300); // 500 − 200 reconciled in place
    expect(await forwardAdjustmentRows(C_RENT)).toHaveLength(0); // NO forward-adjustment for an open month
    expect(await reversalFamilyC(C_RENT)).toBe(30000);
    expect(await ownerIncomeC(C_RENT)).toBe(0);
  });

  // ── XM idempotency across the frozen boundary: re-firing the cross-month sequence converges
  //    to exactly the same rows — no duplication, no growth, frozen row still untouched, R6 clean.
  it("XM idempotency: re-firing the cross-month hook yields exactly the converged rows (no growth)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "500.00", outstanding: "0.00", billingMonth: janStart, dueDate: janDue, number: "XM-IDEM" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: janDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: JAN_M });
    const janFrozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JAN_M });
    const janFrozenAt = janFrozen.firstFrozenAt as Date;
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await seedFrozenReversal({ chargeId: C_RENT, month: frozenStart, monthKey: FROZEN_M, amount: "500.00", direction: "expense", category: "rental_income" });
    const febRev = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });
    await reverseAllocation({ allocationId: allocId, amount: "200.00", createdAt: new Date(janFrozenAt.getTime() + 60_000) });

    // Fire the hook THREE times — must converge, never grow.
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    expect(await forwardAdjustmentRows(C_RENT)).toHaveLength(1); // exactly one, not three
    expect(await ppcReversalRows(C_RENT)).toHaveLength(1);
    const febAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: febRev.id } });
    expect(Number(febAfter.amount.toString())).toBe(500); // frozen row still byte-identical
    expect(febAfter.updatedAt.getTime()).toBe(febRev.updatedAt.getTime());
    expect(await reversalFamilyC(C_RENT)).toBe(30000);
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await openFrozenIntegrityCount()).toBe(0);
  });

  // ── XM target→0 across a freeze: the FULL 500 bounces → targetC = 0. The frozen Feb reversal
  //    (500) must NOT be voided; a compensating give-back (income 500) in the open month nets the
  //    reversal-family to 0 — the frozen row stays byte-identical, R6 clean.
  it("XM target→0: a full bounce after a second freeze nets the family to 0 WITHOUT voiding the frozen reversal", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "500.00", outstanding: "0.00", billingMonth: janStart, dueDate: janDue, number: "XM-ZERO" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: janDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: JAN_M });
    const janFrozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JAN_M });
    const janFrozenAt = janFrozen.firstFrozenAt as Date;
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await seedFrozenReversal({ chargeId: C_RENT, month: frozenStart, monthKey: FROZEN_M, amount: "500.00", direction: "expense", category: "rental_income" });
    const febRev = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });

    // The FULL 500 bounces → ppc_reversal −500 → targetC = max(0, 500 − 500) = 0.
    await reverseAllocation({ allocationId: allocId, amount: "500.00", createdAt: new Date(janFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_RENT }, data: { outstandingAmount: "500.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    // The frozen Feb reversal is NEVER voided (stays active 500, byte-identical).
    const febAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: febRev.id } });
    expect(febAfter.status).toBe("active");
    expect(Number(febAfter.amount.toString())).toBe(500);
    expect(febAfter.updatedAt.getTime()).toBe(febRev.updatedAt.getTime());

    // A compensating give-back (income 500) in the open month nets the family to 0.
    const adj = await forwardAdjustmentRows(C_RENT);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.direction).toBe("income");
    expect(Number(adj[0]!.amount.toString())).toBe(500);
    expect(adj[0]!.statementMonth.getTime()).toBe(curStart.getTime());
    expect(await reversalFamilyC(C_RENT)).toBe(0); // 500 (Feb) − 500 (give-back) = 0
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await openFrozenIntegrityCount()).toBe(0);
    await runSourceToLedger(ledgerCtx, {});
    expect(await s2lOrphanFindings(C_RENT)).toHaveLength(0);
  });

  // ── XM multi-freeze CHAIN (adversarial): rent 500 frozen in month −3; reversal 500 frozen
  //    in −2; a prior bounce 200 already forwarded → forward-adjustment (income 200) + ppc_
  //    reversal (expense 200) frozen in −1. A SECOND bounce (100) now fires → Σppc_reversal =
  //    300 → targetC = max(0, 500 − 300) = 200. The open month must absorb ONLY the remaining
  //    −100 (a give-back 100), while the −2 reversal AND the −1 adjustment stay byte-identical.
  it("XM multi-freeze chain: a third-boundary bounce absorbs into the open month; BOTH frozen reversal-family rows stay byte-identical", async () => {
    const db = getDb();
    const m3Start = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 3, 1)); // rent
    const m3_M = ym(m3Start);
    const m3Due = new Date(Date.UTC(m3Start.getUTCFullYear(), m3Start.getUTCMonth(), 5));
    // revM = janStart (−2), adjM = frozenStart (−1), open = curStart (0).

    // −3: rent 500 collected pre-freeze → income 500; original allocation; freeze → firstFrozenAt.
    await makeRentCharge({ id: C_RENT, status: "void", amount: "500.00", outstanding: "300.00", billingMonth: m3Start, dueDate: m3Due, number: "XM-CHAIN" });
    await seedLedgerRow({ chargeId: C_RENT, month: m3Start, amount: "500.00", direction: "income", category: "rental_income", sourceType: "rent" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: m3Due }); // pre-freeze cash
    const m3Frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: m3_M });
    const firstFrozenAt = m3Frozen.firstFrozenAt as Date;

    // −2: the holdback reversal (expense 500), frozen.
    await seedFrozenReversal({ chargeId: C_RENT, month: janStart, monthKey: JAN_M, amount: "500.00", direction: "expense", category: "rental_income" });
    const revM = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });

    // First bounce 200 (post-freeze) — its ppc_reversal + the resulting forward-adjustment were
    // processed while −1 was the open month, then −1 froze. Seed both into −1 and freeze it.
    const bounce1 = await reverseAllocation({ allocationId: allocId, amount: "200.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await seedLedgerRow({ chargeId: C_RENT, month: frozenStart, amount: "200.00", direction: "expense", category: "rental_income", sourceType: "prior_period_collection_reversal", sourceAllocationEventId: bounce1 });
    await seedLedgerRow({ chargeId: C_RENT, month: frozenStart, amount: "200.00", direction: "income", category: "rental_income", sourceType: "reversal_forward_adjustment" });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const adjM1 = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal_forward_adjustment", sourceChargeId: C_RENT, statementMonth: frozenStart } });

    // Snapshot both frozen reversal-family rows.
    const revBefore = { amountC: Math.round(Number(revM.amount.toString()) * 100), status: revM.status, updatedAt: revM.updatedAt.getTime() };
    const adj1Before = { amountC: Math.round(Number(adjM1.amount.toString()) * 100), direction: adjM1.direction, status: adjM1.status, updatedAt: adjM1.updatedAt.getTime() };

    // NEW: a SECOND bounce of 100 (post-freeze) → Σppc_reversal becomes 300 → targetC = 200.
    await reverseAllocation({ allocationId: allocId, amount: "100.00", createdAt: new Date(firstFrozenAt.getTime() + 120_000) });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    // Both frozen rows are byte-identical.
    const revAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: revM.id } });
    expect(Math.round(Number(revAfter.amount.toString()) * 100)).toBe(revBefore.amountC);
    expect(revAfter.status).toBe(revBefore.status);
    expect(revAfter.updatedAt.getTime()).toBe(revBefore.updatedAt);
    const adj1After = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: adjM1.id } });
    expect(Math.round(Number(adj1After.amount.toString()) * 100)).toBe(adj1Before.amountC);
    expect(adj1After.direction).toBe(adj1Before.direction);
    expect(adj1After.updatedAt.getTime()).toBe(adj1Before.updatedAt);

    // The open month absorbed exactly the remaining −100: new ppc_reversal 100 + give-back 100.
    const openAdj = (await forwardAdjustmentRows(C_RENT)).filter((r) => r.statementMonth.getTime() === curStart.getTime());
    expect(openAdj).toHaveLength(1);
    expect(openAdj[0]!.direction).toBe("income");
    expect(Number(openAdj[0]!.amount.toString())).toBe(100);
    // Σ reversal-family (signed) == targetC == 200 == max(0, 500 − 300).
    expect(await reversalFamilyC(C_RENT)).toBe(20000);
    expect(await ownerIncomeC(C_RENT)).toBe(0);

    // Reconciliation clean across all three frozen months.
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await openFrozenIntegrityCount()).toBe(0);
    await runSourceToLedger(ledgerCtx, {});
    expect(await s2lOrphanFindings(C_RENT)).toHaveLength(0);
  });

  // ── XM oscillation + reroute (adversarial, in-place sign flip): frozen reversal 500 in −2.
  //    Fire 1: a 200 bounce → targetC 300 → open-month give-back INCOME 200. Fire 2: a reroute
  //    RE-collection of 400 (post-freeze ppc) → targetC = max(0, 500 + 400 − 200) = 700 → the
  //    SAME open-month adjustment must FLIP in place to a HOLDBACK EXPENSE 200. Frozen row stays
  //    byte-identical; owner income stays 0; exactly one open-month adjustment throughout.
  it("XM oscillation+reroute: the open-month adjustment flips give-back→holdback in place; frozen row untouched", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_RENT, status: "paid", amount: "500.00", outstanding: "0.00", billingMonth: janStart, dueDate: janDue, number: "XM-OSC" });
    const allocId = await payCharge({ chargeId: C_RENT, amount: "500.00", createdAt: janDue });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: JAN_M });
    const janFrozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JAN_M });
    const janFrozenAt = janFrozen.firstFrozenAt as Date;
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await seedFrozenReversal({ chargeId: C_RENT, month: frozenStart, monthKey: FROZEN_M, amount: "500.00", direction: "expense", category: "rental_income" });
    const revM = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: C_RENT } });
    const revBefore = { amountC: Math.round(Number(revM.amount.toString()) * 100), updatedAt: revM.updatedAt.getTime() };

    // Fire 1 — a 200 bounce → open-month give-back INCOME 200.
    await reverseAllocation({ allocationId: allocId, amount: "200.00", createdAt: new Date(janFrozenAt.getTime() + 60_000) });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    let adj = await forwardAdjustmentRows(C_RENT);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.direction).toBe("income");
    expect(Number(adj[0]!.amount.toString())).toBe(200);
    const adjId = adj[0]!.id;

    // Fire 2 — a reroute RE-collection of 400 (post-freeze) → targetC 700 → FLIP to EXPENSE 200.
    await payCharge({ chargeId: C_RENT, amount: "400.00", createdAt: new Date(janFrozenAt.getTime() + 120_000) });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);

    adj = await forwardAdjustmentRows(C_RENT);
    expect(adj).toHaveLength(1); // still ONE adjustment row, flipped in place (same open month)
    expect(adj[0]!.id).toBe(adjId); // updated in place, not a second row
    expect(adj[0]!.direction).toBe("expense"); // give-back → holdback
    expect(Number(adj[0]!.amount.toString())).toBe(200);

    // Frozen reversal byte-identical; family == targetC 700; owner income 0.
    const revAfter = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: revM.id } });
    expect(Math.round(Number(revAfter.amount.toString()) * 100)).toBe(revBefore.amountC);
    expect(revAfter.updatedAt.getTime()).toBe(revBefore.updatedAt);
    expect(await reversalFamilyC(C_RENT)).toBe(70000); // 500 (Feb) + 200 (open holdback)
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await openFrozenIntegrityCount()).toBe(0);
  });

  // ═══ Finding 1 (final review, MONEY) — forward rows aged into a frozen month must NEVER be
  //     mistaken for that charge's NORMAL frozen row. FORWARD rows (prior_period_collection,
  //     prior_period_collection_reversal, reversal_forward_adjustment, prior_period_adjustment)
  //     are posted into the THEN-open month; once that month later freezes they become active,
  //     non-"reversal" rows carrying a sourceChargeId in a frozen statementMonth. Pre-fix,
  //     postForwardReversalForFrozenMonth's `originals` query filtered only
  //     `sourceType: { not: "reversal" }`, so it swept such an aged forward row in and mistook it
  //     for the frozen NORMAL row — double-counting the same cash (frozenCollectedC = row.amount
  //     AND +ppcC), inflating the write-once holdback and booking owner income NEGATIVE for a
  //     charge that must net to 0. Fix: exclude the COMPLETE forward-source-type list.

  // ── CONTAM (THE confirmed money bug): C1 unpaid at freeze (JAN frozen normal = 0); paid while
  //    FEB is the open month → prior_period_collection +800 lands in FEB; FEB then freezes; C1 is
  //    voided → the JAN forward-reversal correctly holds back 800 (owner income 0). Then ANY
  //    FEB-billed charge is synced while FEB is FROZEN → the sync-hook fires
  //    postForwardReversalForFrozenMonth(O, FEB) → pre-fix it re-sweeps C1's aged ppc row into
  //    `originals`, inflates C1's holdback 800 → 1600, and books owner income −800. Owner income
  //    for the void charge MUST stay 0 (pre-fix: expected -80000 to be +0), and re-firing MUST NOT
  //    oscillate the holdback 800↔1600.
  it("CONTAM: a ppc aged into a frozen month is NOT re-swept as a normal row when that month is re-synced (owner income stays 0, no oscillation)", async () => {
    const db = getDb();

    // JAN (−2): C1 rent 800 billed, UNPAID at freeze → frozen normal row collected 0.
    await makeRentCharge({ id: C_RENT, status: "posted", amount: "800.00", outstanding: "800.00", billingMonth: janStart, dueDate: janDue, number: "CONTAM-C1" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: JAN_M });
    const janNormal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_RENT } });
    expect(Number(janNormal.amount.toString())).toBe(0);
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: JAN_M });

    // C1 paid while FEB is the open month → a prior_period_collection +800 was posted into FEB.
    // Seed that aged ppc into FEB, then FREEZE FEB so it is now a frozen forward row (the exact
    // post-freeze state produced by the real lifecycle; months are runtime-relative to NOW so the
    // ppc cannot be posted into a past month by the live engine — seed + freeze mirrors it).
    await seedLedgerRow({ chargeId: C_RENT, month: frozenStart, amount: "800.00", direction: "income", category: "rental_income", sourceType: "prior_period_collection", sourceAllocationEventId: randomUUID() });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    // C1 voided → sync its (JAN) branch → the forward-reversal correctly holds back 800.
    await db.charge.update({ where: { id: C_RENT }, data: { status: "void" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_RENT]);
    expect(await ownerIncomeC(C_RENT)).toBe(0); // frozen 0 + ppc 800 − holdback 800
    const revBefore = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(revBefore).toHaveLength(1);
    expect(Number(revBefore[0]!.amount.toString())).toBe(800);

    // CONTAMINATION: a DIFFERENT charge billed in the (now frozen) FEB is synced → the hook fires
    // postForwardReversalForFrozenMonth(O, FEB), which must IGNORE C1's aged ppc row.
    await makeRentCharge({ id: C_CUR, status: "posted", amount: "300.00", outstanding: "300.00", billingMonth: frozenStart, dueDate: frozenDue, number: "CONTAM-C2" });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_CUR]);

    // Owner income for the VOID charge stays 0 — the holdback was NOT inflated to 1600.
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    const revAfter = (await forwardReversalRows(C_RENT)).filter((r) => r.status === "active");
    expect(revAfter).toHaveLength(1);
    expect(Number(revAfter[0]!.amount.toString())).toBe(800); // NOT 1600

    // Re-fire the frozen-FEB sync again → stable (no 800↔1600 oscillation across syncs).
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [C_CUR]);
    expect(await ownerIncomeC(C_RENT)).toBe(0);
    expect(Number((await forwardReversalRows(C_RENT)).filter((r) => r.status === "active")[0]!.amount.toString())).toBe(800);
  });

  // ── frozen-ppc (originals-exclusion unit assertion): a prior_period_collection sitting in a
  //    FROZEN month is NEVER treated as that charge's normal frozen row — postForwardReversalFor-
  //    FrozenMonth's `originals` must exclude it, so re-running that month manufactures NO holdback
  //    from it. Pre-fix `originals` swept the ppc (not "reversal") → a spurious reversal of 1600.
  it("frozen-ppc: postForwardReversalForFrozenMonth ignores a prior_period_collection aged into the frozen month (originals excludes it → reversed 0)", async () => {
    // A VOID charge whose ONLY row in FEB is an aged prior_period_collection (no normal row).
    await makeRentCharge({ id: C_RENT, status: "void", amount: "800.00", outstanding: "800.00", billingMonth: janStart, dueDate: janDue, number: "FROZEN-PPC" });
    await seedLedgerRow({ chargeId: C_RENT, month: frozenStart, amount: "800.00", direction: "income", category: "rental_income", sourceType: "prior_period_collection", sourceAllocationEventId: randomUUID() });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    // Re-run FEB through the money engine — the aged ppc must NOT be seen as a normal frozen row.
    const res = await postForwardReversalForFrozenMonth(ledgerCtx, OWNER, FROZEN_M);
    expect(res.reversed).toBe(0); // originals excluded the ppc → nothing to reverse
    expect(await forwardReversalRows(C_RENT)).toHaveLength(0); // no holdback manufactured from a ppc
  });
});
