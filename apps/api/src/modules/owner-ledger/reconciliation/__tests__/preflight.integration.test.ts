/**
 * preflight.integration.test.ts — R9/R10 executable enablement preflight.
 *
 * `runEnablementPreflight(ctx)` decides whether ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER
 * is safe to enable. It is READ-ONLY and MUST run INDEPENDENT of that flag (R10) — this
 * suite leaves the flag UNSET throughout and the preflight still evaluates. `pass:true`
 * ONLY when ALL hold:
 *   1. a full-scope `completed` run of EACH reconciliation type with completedAt within
 *      the 24h recency window (failed/running/stale/filtered do NOT satisfy);
 *   2. zero unresolved critical source_to_ledger findings (open|acknowledged unresolved);
 *   3. zero unresolved critical frozen_integrity findings;
 *   4. no unposted paid-after-freeze collections (post-freeze allocation/reversal events
 *      with no matching prior_period_collection/_reversal row);
 *   5. no frozen period lacking a manifest (status=frozen AND firstFrozenAt IS NULL).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/preflight.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../../lib/auth";
import { runEnablementPreflight } from "../preflight";
import { reconciliationRoutes } from "../reconciliation.routes";
import { runOwnerClosedPeriodPreflightCli } from "../../../../cron/owner-closed-period-preflight";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 7a10; unused by any other suite) ───────────────
const ORG = "7a100000-0000-4000-8000-000000000001";
const USER = "7a100000-0000-4000-8000-000000000002";
const OWNER = "7a100000-0000-4000-8000-000000000003";
const TENANT = "7a100000-0000-4000-8000-000000000004";
const PROP = "7a100000-0000-4000-8000-000000000005";
const APT = "7a100000-0000-4000-8000-000000000006";
const UNIT = "7a100000-0000-4000-8000-000000000007";
const TEN = "7a100000-0000-4000-8000-000000000008";
const OTHER_ORG = "7a100000-0000-4000-8000-0000000000c1";

const ctx = { orgId: ORG };

const HOUR = 60 * 60 * 1000;
const NOW = new Date();
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const frozenDue = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), 5));

type CheckType = "source_to_ledger" | "frozen_integrity";

async function seedRun(o: {
  type: CheckType;
  status: "running" | "completed" | "failed";
  isFullScope?: boolean;
  completedAt?: Date | null;
}) {
  return getDb().ownerLedgerReconciliationRun.create({
    data: {
      organizationId: ORG,
      reconciliationType: o.type,
      isFullScope: o.isFullScope ?? true,
      status: o.status,
      triggerType: "cron",
      completedAt: o.completedAt === undefined ? new Date() : o.completedAt,
    },
  });
}

/** Two fresh full-scope completed runs (one of each type), completed just now. */
async function seedGoodRuns() {
  await seedRun({ type: "source_to_ledger", status: "completed", completedAt: new Date() });
  await seedRun({ type: "frozen_integrity", status: "completed", completedAt: new Date() });
}

async function seedFrozenPeriod(o: { apartmentId?: string | null; firstFrozenAt: Date | null; periodMonth?: Date; status?: "open" | "frozen" }) {
  const periodMonth = o.periodMonth ?? frozenStart;
  const apartmentId = o.apartmentId ?? null;
  return getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId,
      periodMonth,
      status: o.status ?? "frozen",
      idempotencyKey: `ownerstmt:${OWNER}:${randomUUID()}${apartmentId ? `:${apartmentId}` : ""}`,
      sourceMaxUpdatedAt: new Date(),
      firstFrozenAt: o.firstFrozenAt,
    },
  });
}

async function seedFinding(o: {
  checkKind: CheckType;
  severity?: "critical" | "warning";
  status?: "open" | "acknowledged" | "resolved" | "ignored";
}) {
  return getDb().ownerLedgerReconciliationFinding.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      checkKind: o.checkKind,
      findingType: o.checkKind === "source_to_ledger" ? "missing_ledger_row" : "post_freeze_creation",
      sourceType: o.checkKind === "source_to_ledger" ? "rent" : "owner_ledger_entry",
      sourceId: randomUUID(),
      severity: o.severity ?? "critical",
      status: o.status ?? "open",
      lastDetectedAt: new Date(),
    },
  });
}

/** Minimal owner-unit graph so a Charge can be attributed to OWNER via unit.ownerPartyId. */
async function seedOwnerUnitGraph() {
  const db = getDb();
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "PF Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "PF Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "PF Tower", propertyCode: "PF-P1", propertyType: "apartment", addressLine1: "1 PF St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "PF-01-01", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "PF-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2025, 0, 1)), monthlyRentAmount: "800" } });
}

/** A frozen-month rent charge + its frozen-month normal ledger row (baseline for R3). */
async function seedFrozenCharge(chargeId: string): Promise<void> {
  const db = getDb();
  await db.charge.create({
    data: {
      id: chargeId, organizationId: ORG, chargeNumber: `PF-${chargeId.slice(-6)}`, partyId: TENANT, tenancyId: TEN, unitId: UNIT,
      chargeType: "rent", status: "paid", postedAt: new Date(), dueDate: frozenDue, amount: "800.00",
      currency: "MYR", outstandingAmount: "0.00", billingMonth: frozenStart,
    },
  });
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, tenancyId: TEN,
      statementMonth: frozenStart, transactionDate: frozenDue, direction: "income", category: "rental_income",
      amount: "0.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true,
      sourceType: "rent", sourceChargeId: chargeId, status: "active", createdById: USER, updatedById: USER,
    },
  });
}

/** A post-freeze PaymentAllocation on a charge (createdAt after firstFrozenAt). */
async function seedPostFreezeAllocation(chargeId: string, createdAt: Date): Promise<string> {
  const db = getDb();
  const paymentId = randomUUID();
  await db.payment.create({ data: { id: paymentId, organizationId: ORG, paymentNumber: `PF-PAY-${randomUUID().slice(-6)}`, partyId: TENANT, paymentType: "tenant_payment", // "posted" is the only status meaning money arrived; "completed" is written nowhere in production.
    paymentMethod: "bank_transfer", status: "posted", amount: "800.00", currency: "MYR", receivedAt: createdAt } });
  const allocId = randomUUID();
  await db.paymentAllocation.create({ data: { id: allocId, organizationId: ORG, paymentId, chargeId, allocatedAmount: "800.00", allocatedAt: createdAt, createdAt } });
  return allocId;
}

/** A post-freeze PaymentAllocationReversal against an existing allocation. */
async function seedReversal(originalAllocationId: string, createdAt: Date): Promise<string> {
  const id = randomUUID();
  await getDb().paymentAllocationReversal.create({
    data: { id, organizationId: ORG, originalAllocationId, amount: "800.00", reason: "test reversal", reversedById: USER, createdAt, idempotencyKey: `PF-REV-${id}` },
  });
  return id;
}

/** An already-posted forward row for a given allocation/reversal event (idempotency-key row). */
async function seedForwardRow(o: { sourceType: "prior_period_collection" | "prior_period_collection_reversal"; sourceAllocationEventId: string; sourceChargeId: string; status?: string }): Promise<void> {
  await getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, tenancyId: TEN,
      statementMonth: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)), transactionDate: new Date(),
      direction: o.sourceType === "prior_period_collection" ? "income" : "expense", category: "rental_income",
      amount: "800.00", paidBy: "kaen", paymentStatus: "paid", includeInPayout: true,
      sourceType: o.sourceType, sourceChargeId: o.sourceChargeId, sourceAllocationEventId: o.sourceAllocationEventId,
      status: o.status ?? "active", createdById: USER, updatedById: USER,
    },
  });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerReconciliationRun.deleteMany({ where: org });
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

let savedLedger: string | undefined;

dn("runEnablementPreflight — executable enablement preflight (R9/R10, integration)", () => {
  beforeAll(async () => {
    // R10: prove the preflight evaluates with LIVE_LEDGER explicitly UNSET.
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    await cleanup();
    await getDb().organization.create({
      data: {
        id: ORG, name: "7A10 Preflight Org", slug: "7a10-preflight-org", status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
  });
  afterAll(async () => {
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    const db = getDb();
    const org = { organizationId: ORG };
    await db.ownerLedgerReconciliationRun.deleteMany({ where: org });
    await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
    await db.paymentAllocationReversal.deleteMany({ where: org });
    await db.paymentAllocation.deleteMany({ where: org });
    await db.payment.deleteMany({ where: org });
    await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
    await db.ownerStatementPeriod.deleteMany({ where: org });
    await db.ownerLedgerEntry.deleteMany({ where: org });
    await db.charge.deleteMany({ where: org });
    await db.tenancy.deleteMany({ where: org });
    await db.listing.deleteMany({ where: org });
    await db.apartment.deleteMany({ where: org });
    await db.property.deleteMany({ where: org });
    await db.party.deleteMany({ where: org });
  });

  // ── P1: all conditions hold → pass:true (tracer bullet, flag UNSET) ───────────────
  it("P1: recent full-scope completed runs of both types + zero critical + no unposted + all manifested → pass:true", async () => {
    expect(process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER).toBeUndefined(); // flag-independent (R10)
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) }); // manifested, no post-freeze cash

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.checks.recencyWindowHours).toBe(24);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(true);
    expect(result.checks.runs.frozen_integrity.satisfied).toBe(true);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(0);
    expect(result.checks.openCriticalFindings.frozen_integrity).toBe(0);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(0);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(0);
  });

  // ── P4: only a FAILED run of a type does not satisfy recency → pass:false ──────────
  it("P4: only a failed source_to_ledger run (no completed run) → pass:false with the recency reason", async () => {
    await seedRun({ type: "frozen_integrity", status: "completed", completedAt: new Date() }); // the other type is fine
    await seedRun({ type: "source_to_ledger", status: "failed", completedAt: new Date() }); // failed ≠ satisfied
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(false);
    expect(result.checks.runs.frozen_integrity.satisfied).toBe(true);
    expect(result.reasons.some((r) => r.includes("source_to_ledger run within the last 24h"))).toBe(true);
  });

  // ── P3: only a FILTERED (non-full-scope) completed run does not satisfy → pass:false ─
  it("P3: only a filtered (non-full-scope) completed source_to_ledger run → pass:false with the recency reason", async () => {
    await seedRun({ type: "frozen_integrity", status: "completed", completedAt: new Date() });
    await seedRun({ type: "source_to_ledger", status: "completed", isFullScope: false, completedAt: new Date() }); // filtered ≠ satisfied
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.includes("source_to_ledger run within the last 24h"))).toBe(true);
  });

  // ── P5: a STALE completed full-scope run (completedAt > 24h ago) does not satisfy ──
  it("P5: a stale (>24h) completed full-scope source_to_ledger run → pass:false with the recency reason", async () => {
    await seedRun({ type: "frozen_integrity", status: "completed", completedAt: new Date() });
    await seedRun({ type: "source_to_ledger", status: "completed", completedAt: new Date(NOW.getTime() - 25 * HOUR) }); // stale
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(false);
    expect(result.checks.runs.source_to_ledger.latestCompletedAt).not.toBeNull(); // found, but rejected on recency
    expect(result.reasons.some((r) => r.includes("source_to_ledger run within the last 24h"))).toBe(true);
  });

  // ── P8: only a RUNNING run of a type does not satisfy recency → pass:false ─────────
  it("P8: only a running source_to_ledger run (no completed run) → pass:false with the recency reason", async () => {
    await seedRun({ type: "frozen_integrity", status: "completed", completedAt: new Date() });
    await seedRun({ type: "source_to_ledger", status: "running", completedAt: null }); // mid-run, never completed
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.includes("source_to_ledger run within the last 24h"))).toBe(true);
  });

  // ── P2: an OPEN critical source_to_ledger finding → pass:false ─────────────────────
  it("P2: an open critical source_to_ledger finding → pass:false with a findings reason", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    await seedFinding({ checkKind: "source_to_ledger", severity: "critical", status: "open" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(1);
    expect(result.reasons.some((r) => r.includes("unresolved critical source_to_ledger"))).toBe(true);
  });

  // ── P22: an open critical frozen_integrity finding → pass:false (both kinds gate) ──
  it("P22: an open critical frozen_integrity finding → pass:false with its own findings reason", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    await seedFinding({ checkKind: "frozen_integrity", severity: "critical", status: "open" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.openCriticalFindings.frozen_integrity).toBe(1);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(0); // isolated to the right kind
    expect(result.reasons.some((r) => r.includes("unresolved critical frozen_integrity"))).toBe(true);
  });

  // ── P9: an ACKNOWLEDGED critical finding is still unresolved → pass:false ──────────
  it("P9: an acknowledged critical source_to_ledger finding counts as unresolved → pass:false", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    await seedFinding({ checkKind: "source_to_ledger", severity: "critical", status: "acknowledged" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(1); // acknowledged still counted
    expect(result.reasons.some((r) => r.includes("unresolved critical source_to_ledger"))).toBe(true);
  });

  // ── P10: RESOLVED and IGNORED critical findings clear → they do NOT block ──────────
  it("P10: resolved and ignored critical findings do not block → pass:true", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    await seedFinding({ checkKind: "source_to_ledger", severity: "critical", status: "resolved" });
    await seedFinding({ checkKind: "source_to_ledger", severity: "critical", status: "ignored" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(0); // resolved + ignored both cleared
  });

  // ── P21: an open WARNING finding (no critical) does not block → pass:true ──────────
  it("P21: an open warning-severity finding does not block → pass:true", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    await seedFinding({ checkKind: "source_to_ledger", severity: "warning", status: "open" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.openCriticalFindings.source_to_ledger).toBe(0); // warning is not critical
  });

  // ── P6: a post-freeze allocation with NO matching forward row → unposted → fail ────
  it("P6: a post-freeze PaymentAllocation with no prior_period_collection row → pass:false", async () => {
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId);
    await seedPostFreezeAllocation(chargeId, new Date()); // createdAt now > firstFrozenAt; NO forward row posted

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(1);
    expect(result.reasons.some((r) => r.includes("unposted paid-after-freeze"))).toBe(true);
  });

  // ── P18: a post-freeze REVERSAL of a PRE-freeze allocation, no forward reversal row ─
  it("P18: a post-freeze reversal of a pre-freeze allocation with no prior_period_collection_reversal → pass:false", async () => {
    const firstFrozenAt = new Date(NOW.getTime() - 2 * HOUR);
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId);
    // Allocation created BEFORE the freeze (already in the frozen collected figure) …
    const allocId = await seedPostFreezeAllocation(chargeId, new Date(NOW.getTime() - 3 * HOUR));
    // … reversed AFTER the freeze — R3 forwards this reversal event, but none was posted.
    await seedReversal(allocId, new Date(NOW.getTime() - HOUR));

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(1); // the reversal event, not the pre-freeze allocation
    expect(result.reasons.some((r) => r.includes("unposted paid-after-freeze"))).toBe(true);
  });

  // ── P19: a forward row that exists but is VOIDED (status != active) → still unposted ─
  it("P19: a post-freeze allocation whose prior_period_collection row is voided → pass:false (re-flagged)", async () => {
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId);
    const allocId = await seedPostFreezeAllocation(chargeId, new Date());
    // A forward row EXISTS on the idempotency key but was later VOIDED — R3's skipDuplicates
    // will never re-post it, so the cash is dropped and the event must re-flag as unposted.
    await seedForwardRow({ sourceType: "prior_period_collection", sourceAllocationEventId: allocId, sourceChargeId: chargeId, status: "void" });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(1);
  });

  // ── P20: an allocation created EXACTLY at firstFrozenAt is in the frozen figure → NOT unposted ─
  it("P20: an allocation at the exact freeze boundary is not unposted (strict >, matches R3) → pass:true", async () => {
    const firstFrozenAt = new Date(NOW.getTime() - HOUR);
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId);
    await seedPostFreezeAllocation(chargeId, firstFrozenAt); // createdAt == firstFrozenAt (boundary, already counted at freeze)

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(0);
  });

  // ── P_ORPH (safety net, review C1): a VOID/credited frozen-month charge carrying an ─
  // orphaned prior_period_collection (over-credit) must fail the preflight. countUnposted
  // PaidAfterFreeze EXCLUDES void/credited charges, so without a dedicated check the
  // orphan is invisible → false-pass. The complement check asserts booked ∈ [0, effAlloc].
  it("P_ORPH: a void charge with an orphaned prior_period_collection (over-credit) → pass:false", async () => {
    const db = getDb();
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - 2 * HOUR) });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId); // frozen normal row collected 0
    // Paid post-freeze, bounced, then the charge voided → effective allocated 0.
    const allocId = await seedPostFreezeAllocation(chargeId, new Date(NOW.getTime() - HOUR));
    await seedReversal(allocId, new Date(NOW.getTime() - HOUR / 2));
    await db.charge.update({ where: { id: chargeId }, data: { status: "void", outstandingAmount: "800.00" } });
    // A +800 forward collection posted, but the compensating reversal is MISSING.
    await seedForwardRow({ sourceType: "prior_period_collection", sourceAllocationEventId: allocId, sourceChargeId: chargeId });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.orphanedForwardCollections).toBe(1);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(0); // void charge is invisible to that check
    expect(result.reasons.some((r) => r.includes("orphaned"))).toBe(true);
  });

  // ── P_ORPH_NEG: a void charge whose forward collection is correctly compensated ─────
  // (ppc + ppc_reversal net 0) is within range → does NOT block the preflight.
  it("P_ORPH_NEG: a void charge with a correctly compensated forward collection → pass:true", async () => {
    const db = getDb();
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - 2 * HOUR) });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId);
    const allocId = await seedPostFreezeAllocation(chargeId, new Date(NOW.getTime() - HOUR));
    const revId = await seedReversal(allocId, new Date(NOW.getTime() - HOUR / 2));
    await db.charge.update({ where: { id: chargeId }, data: { status: "void", outstandingAmount: "800.00" } });
    await seedForwardRow({ sourceType: "prior_period_collection", sourceAllocationEventId: allocId, sourceChargeId: chargeId });
    await seedForwardRow({ sourceType: "prior_period_collection_reversal", sourceAllocationEventId: revId, sourceChargeId: chargeId });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.orphanedForwardCollections).toBe(0); // booked 0, effAlloc 0 → in range
  });

  // ── P_HOLDBACK_MISSING (holdback rule — Case B fail-closed): a VOID charge whose ──────
  // post-freeze collection is RETAINED (no PaymentAllocationReversal → effAlloc stays 800)
  // but has NO holdback `reversal` row → owner over-credited 800 for a void charge. The
  // cash-conservation band passes (booked 800 == effAlloc 800), so ONLY the exact reversal
  // identity revC == max(0, frozen + Σppc − Σppc_reversal) catches it → preflight fails-closed.
  it("P_HOLDBACK_MISSING: a void charge with a retained post-freeze collection and no holdback reversal → pass:false", async () => {
    const db = getDb();
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - 2 * HOUR) });
    const chargeId = randomUUID();
    await seedFrozenCharge(chargeId); // frozen normal row collected 0
    // Paid post-freeze and RETAINED (NO reversal), then the charge voided → effAlloc 800.
    const allocId = await seedPostFreezeAllocation(chargeId, new Date(NOW.getTime() - HOUR));
    await db.charge.update({ where: { id: chargeId }, data: { status: "void", outstandingAmount: "800.00" } });
    // A +800 forward collection posted, but NO holdback reversal → owner recognises 800.
    await seedForwardRow({ sourceType: "prior_period_collection", sourceAllocationEventId: allocId, sourceChargeId: chargeId });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.orphanedForwardCollections).toBe(1);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(0); // the allocation IS forwarded; the gap is the missing holdback
    expect(result.reasons.some((r) => r.includes("orphaned"))).toBe(true);
  });

  // ── P_ORPH_EXPENSE (review self-heal — reversal-family sign is direction-relative): a VOID
  // owner EXPENSE charge (e.g. a management_fee) whose holdback `reversal` is INCOME (gives the
  // owner back the docked fee). This gate scans ALL charge types, so the reversal-family sum
  // MUST sign relative to the frozen normal row's direction (expense charge ⇒ reversalDir =
  // income ⇒ the income reversal is +). Hardcoding "expense=+" would invert it (−108) → a false
  // orphan → preflight false-FAIL. A correctly held-back void expense must pass CLEAN.
  it("P_ORPH_EXPENSE: a void EXPENSE charge with an income holdback reversal is NOT a false orphan → pass:true", async () => {
    const db = getDb();
    await seedGoodRuns();
    await seedOwnerUnitGraph();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - 2 * HOUR) });
    const chargeId = randomUUID();
    // A void owner management_fee EXPENSE charge (no tenant allocations → effAlloc 0).
    await db.charge.create({
      data: { id: chargeId, organizationId: ORG, chargeNumber: `PF-EXP-${chargeId.slice(-6)}`, partyId: OWNER, unitId: UNIT, chargeType: "management_fee", status: "void", postedAt: new Date(), dueDate: frozenDue, amount: "108.00", currency: "MYR", outstandingAmount: "108.00", billingMonth: frozenStart },
    });
    // Frozen normal EXPENSE row (108) + its forward holdback `reversal` (INCOME 108) into the open month.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: frozenStart, transactionDate: frozenDue, direction: "expense", category: "management_fee", amount: "108.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true, sourceType: "statement", sourceChargeId: chargeId, status: "active", createdById: USER, updatedById: USER },
    });
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)), transactionDate: new Date(), direction: "income", category: "management_fee", amount: "108.00", paidBy: "kaen", paymentStatus: "paid", includeInPayout: true, sourceType: "reversal", sourceChargeId: chargeId, status: "active", createdById: USER, updatedById: USER },
    });

    const result = await runEnablementPreflight(ctx);

    expect(result.checks.orphanedForwardCollections).toBe(0); // income reversal +108 == targetRev 108
    expect(result.pass).toBe(true);
  });

  // ── P_PU (review row 4 — combined-scope invariant): a frozen PER-UNIT period ───────
  // (apartmentId != null) with NO frozen COMBINED period for the same owner-month is
  // unguarded (assertPeriodOpen) and unscanned (R5/R6) — those are combined-scope only.
  // Enablement must fail-closed until the combined period is also frozen, so the
  // combined-scope guard/reconciliation actually cover it. (Reachable via a lazy
  // per-unit portal freeze, or a cron combined-freeze failure.)
  it("P_PU: a frozen per-unit period without a frozen combined period for the same owner-month → pass:false", async () => {
    await seedGoodRuns();
    // A per-unit frozen period WITH a manifest boundary — but NO combined sibling.
    await seedFrozenPeriod({ apartmentId: APT, firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.perUnitFrozenWithoutCombined).toBe(1);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(0); // manifested — NOT the manifest gap
    expect(result.reasons.some((r) => r.includes("per-unit") && r.includes("combined"))).toBe(true);
  });

  // ── P_PU_NEG: a frozen per-unit period WITH its frozen combined sibling → allowed ───
  it("P_PU_NEG: a frozen per-unit period with a frozen combined sibling for the same owner-month → pass:true", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) }); // combined
    await seedFrozenPeriod({ apartmentId: APT, firstFrozenAt: new Date(NOW.getTime() - HOUR) }); // per-unit sibling

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.perUnitFrozenWithoutCombined).toBe(0);
  });

  // ── P7: a frozen period with firstFrozenAt NULL (no manifest) → fail-closed ────────
  it("P7: a frozen period lacking a manifest (firstFrozenAt null) → pass:false", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: null }); // frozen before the manifest feature — integrity unknown

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(1);
    expect(result.reasons.some((r) => r.includes("frozen period(s) lacking a freeze manifest"))).toBe(true);
  });

  // ── P23: an OPEN period with null firstFrozenAt must NOT block (status filter) ─────
  it("P23: an open (non-frozen) period with null firstFrozenAt does not block → pass:true", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) }); // a real frozen+manifested period
    await seedFrozenPeriod({ status: "open", firstFrozenAt: null, periodMonth: new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)) }); // open, naturally unfrozen

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(0); // open periods are not a manifest gap
  });

  // ── P24: a PER-UNIT frozen period with null firstFrozenAt is also fail-closed ──────
  it("P24: a per-unit (apartmentId!=null) frozen period lacking a manifest → pass:false (fail-closed)", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ apartmentId: APT, firstFrozenAt: null });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(1); // per-unit is not excluded from the manifest gate
  });

  // ── P25: one of several frozen periods lacks a manifest → fail (not masked) ────────
  it("P25: with multiple frozen periods, a single one lacking a manifest → pass:false", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) }); // manifested
    await seedFrozenPeriod({ firstFrozenAt: null, periodMonth: new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth() - 1, 1)) }); // legacy, no manifest

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(1);
  });

  // ── P12: the result always surfaces the two documented known limitations ──────────
  it("P12: limitations[] always carries the two documented known gaps (operator visibility)", async () => {
    await seedGoodRuns();
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.limitations).toHaveLength(2);
    expect(result.limitations.some((l) => l.includes("EXPENSE charges") && l.includes("expectedStatementLedgerRows"))).toBe(true);
    expect(result.limitations.some((l) => l.includes("post-monthly-rent") && l.includes("closed-period guard"))).toBe(true);
  });

  // ── P16: cross-org isolation — another org's green state must not leak in ──────────
  it("P16: another org's completed runs and open critical findings do not satisfy/fail THIS org", async () => {
    const db = getDb();
    await db.organization.create({
      data: { id: OTHER_ORG, name: "7A10 Other", slug: "7a10-other-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
    });
    try {
      // OTHER_ORG is perfectly green (both types recent+completed) AND carries an open critical finding.
      await db.ownerLedgerReconciliationRun.create({ data: { organizationId: OTHER_ORG, reconciliationType: "source_to_ledger", isFullScope: true, status: "completed", triggerType: "cron", completedAt: new Date() } });
      await db.ownerLedgerReconciliationRun.create({ data: { organizationId: OTHER_ORG, reconciliationType: "frozen_integrity", isFullScope: true, status: "completed", triggerType: "cron", completedAt: new Date() } });
      await db.ownerLedgerReconciliationFinding.create({ data: { organizationId: OTHER_ORG, ownerPartyId: OWNER, checkKind: "source_to_ledger", findingType: "missing_ledger_row", sourceType: "rent", sourceId: randomUUID(), severity: "critical", status: "open", lastDetectedAt: new Date() } });
      // THIS org (ORG) has NOTHING.
      const result = await runEnablementPreflight(ctx);

      expect(result.pass).toBe(false); // ORG did NOT borrow OTHER_ORG's runs
      expect(result.checks.runs.source_to_ledger.satisfied).toBe(false);
      expect(result.checks.runs.frozen_integrity.satisfied).toBe(false);
      expect(result.checks.openCriticalFindings.source_to_ledger).toBe(0); // did NOT see OTHER_ORG's finding
    } finally {
      await db.ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: OTHER_ORG } });
      await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: OTHER_ORG } });
      await db.organization.deleteMany({ where: { id: OTHER_ORG } });
    }
  });

  // ── P17: EACH type is required — a totally-absent type fails on its own reason ─────
  it("P17: a completed source_to_ledger run but ZERO frozen_integrity runs → pass:false", async () => {
    await seedRun({ type: "source_to_ledger", status: "completed", completedAt: new Date() });
    await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.checks.runs.source_to_ledger.satisfied).toBe(true);
    expect(result.checks.runs.frozen_integrity.satisfied).toBe(false);
    expect(result.reasons.some((r) => r.includes("frozen_integrity run within the last 24h"))).toBe(true);
  });

  // ── P26: read-only (R10) — the preflight writes nothing and mutates no period ──────
  it("P26: running the preflight creates no runs/findings and does not mutate the frozen period", async () => {
    const db = getDb();
    await seedGoodRuns();
    const period = await seedFrozenPeriod({ firstFrozenAt: new Date(NOW.getTime() - HOUR) });
    const runsBefore = await db.ownerLedgerReconciliationRun.count({ where: { organizationId: ORG } });
    const findingsBefore = await db.ownerLedgerReconciliationFinding.count({ where: { organizationId: ORG } });
    const before = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: period.id }, select: { updatedAt: true } });

    await runEnablementPreflight(ctx);

    expect(await db.ownerLedgerReconciliationRun.count({ where: { organizationId: ORG } })).toBe(runsBefore);
    expect(await db.ownerLedgerReconciliationFinding.count({ where: { organizationId: ORG } })).toBe(findingsBefore);
    const after = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: period.id }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  // ── P27: an empty org fails CLOSED with BOTH recency reasons (not a throw) ─────────
  it("P27: an org with no runs at all → pass:false with a recency reason for EACH type", async () => {
    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.reasons.filter((r) => r.includes("run within the last 24h"))).toHaveLength(2);
  });

  // ── P28: failing conditions ACCUMULATE — a distinct reason per condition ───────────
  it("P28: multiple simultaneous defects yield a distinct reason per failing condition (no short-circuit)", async () => {
    // No runs (2 recency reasons) + an open critical finding + a frozen period with no manifest.
    await seedFinding({ checkKind: "source_to_ledger", severity: "critical", status: "open" });
    await seedFrozenPeriod({ firstFrozenAt: null });

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(false);
    expect(result.reasons.filter((r) => r.includes("run within the last 24h"))).toHaveLength(2);
    expect(result.reasons.some((r) => r.includes("unresolved critical source_to_ledger"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("frozen period(s) lacking a freeze manifest"))).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });

  // ── P29: no frozen periods at all → conditions 4 & 5 vacuously clean → pass:true ──
  it("P29: with good runs and zero frozen periods, the preflight passes (empty scans are clean)", async () => {
    await seedGoodRuns();

    const result = await runEnablementPreflight(ctx);

    expect(result.pass).toBe(true);
    expect(result.checks.unpostedPaidAfterFreeze).toBe(0);
    expect(result.checks.frozenPeriodsMissingManifest).toBe(0);
  });

  // ── P14: the headless CLI aggregates per-org preflight; overallPass reflects failures ─
  it("P14: the CLI evaluates every org and overallPass is false when an org fails", async () => {
    // ORG is left in a FAILING state (beforeEach cleared its runs) → its preflight fails.
    const cli = await runOwnerClosedPeriodPreflightCli();

    const mine = cli.orgs.find((o) => o.orgId === ORG);
    expect(mine).toBeDefined(); // every org is evaluated
    expect(mine!.pass).toBe(false); // matches runEnablementPreflight(ORG)
    expect(mine!.reasons.some((r) => r.includes("run within the last 24h"))).toBe(true);
    expect(cli.overallPass).toBe(false); // any failing org ⇒ overall false (fail-closed gate)
  });
});

// ─── P13: GET /enablement-preflight route (admin-only, returns { data }) ────────────
const PREFIX = "/api/owner-ledger-reconciliation";
const adminSession: SessionPayload = { userId: USER, orgId: ORG, role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: USER, orgId: ORG, role: "manager", userType: "operator" };
const ownerSession: SessionPayload = { userId: USER, orgId: ORG, role: "viewer", userType: "owner" };

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route(PREFIX, reconciliationRoutes);
  return app;
}

dn("GET /enablement-preflight — admin preflight endpoint (R9/R10, integration)", () => {
  let savedBilling: string | undefined;
  let savedLedger2: string | undefined;
  beforeAll(async () => {
    // R10: reachable with BOTH phase-2 flags UNSET (distinct-prefix mount escapes the gate).
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedLedger2 = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    await getDb().ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
    await getDb().organization.deleteMany({ where: { id: ORG } });
    await getDb().organization.create({
      data: { id: ORG, name: "7A10 Preflight Route Org", slug: "7a10-preflight-route-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
    });
  });
  afterAll(async () => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedLedger2 === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger2;
    await getDb().ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
    await getDb().organization.deleteMany({ where: { id: ORG } });
  });

  // ── P13a: admin GET returns 200 + { data: <preflight result> } ────────────────────
  it("P13a: admin GET /enablement-preflight returns 200 with { data } carrying the preflight result", async () => {
    const res = await makeApp(adminSession).request(`${PREFIX}/enablement-preflight`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.pass).toBe("boolean");
    expect(Array.isArray(body.data.reasons)).toBe(true);
    expect(body.data.checks.recencyWindowHours).toBe(24);
    expect(body.data.limitations).toHaveLength(2);
  });

  // ── P13b: admin-only — 401 without a session, 403 for manager/owner ───────────────
  it("P13b: GET /enablement-preflight requires operator admin — 401 anon, 403 manager/owner", async () => {
    expect((await makeApp(null).request(`${PREFIX}/enablement-preflight`)).status).toBe(401);
    expect((await makeApp(managerSession).request(`${PREFIX}/enablement-preflight`)).status).toBe(403);
    expect((await makeApp(ownerSession).request(`${PREFIX}/enablement-preflight`)).status).toBe(403);
  });
});
