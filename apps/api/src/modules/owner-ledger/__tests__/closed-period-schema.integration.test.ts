/**
 * Commit 2 (Task 3 + Task 5) — closed-period integrity ADDITIVE SCHEMA, DB-backed.
 * MONEY-CRITICAL: pins the Postgres constraint semantics that keep owner money from
 * silently corrupting once the forward-collection / reconciliation feature ships:
 *   - the new (org, sourceType, sourceAllocationEventId) idempotency unique,
 *   - the sourceChargeId unique NARROWED to a partial index that EXCLUDES the two
 *     forward-collection sourceTypes (multiple rows per charge) but still covers
 *     prior_period_adjustment and the normal (manual/rent/statement) types,
 *   - the write-once OwnerStatementPeriod freeze header,
 *   - the durable freeze-manifest / reconciliation-finding / reconciliation-run tables.
 *
 * Gated on RUN_INTEGRATION=1 and refuses any non-local DB host.
 * Run:
 *   npm --workspace @kason/db exec -- prisma generate   # once, after schema edit
 *   set -a; . <repo>/.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     npx vitest run src/modules/owner-ledger/__tests__/closed-period-schema.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix c2f0 — unused by any other suite).
const ORG = "c2f00000-0000-4000-8000-000000000001";
const ORG2 = "c2f00000-0000-4000-8000-0000000000f2";
const OWNER = "c2f00000-0000-4000-8000-000000000003";
const PROP = "c2f00000-0000-4000-8000-000000000004";
const USER = "c2f00000-0000-4000-8000-000000000005";
const CHARGE_A = "c2f00000-0000-4000-8000-00000000000a";
const CHARGE_B = "c2f00000-0000-4000-8000-00000000000b";
const ALLOC_1 = "c2f00000-0000-4000-8000-000000000011";
const ALLOC_2 = "c2f00000-0000-4000-8000-000000000012";
const PERIOD_B4 = "c2f00000-0000-4000-8000-000000000041";
const PERIOD_B7 = "c2f00000-0000-4000-8000-000000000071";
const LEDGER_1 = "c2f00000-0000-4000-8000-000000000051";
const SOURCE_ID = "c2f00000-0000-4000-8000-000000000061";

const MONTH = new Date(Date.UTC(2026, 2, 1)); // frozen month M = 2026-03

function ledgerData(over: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROP,
    statementMonth: MONTH,
    transactionDate: MONTH,
    direction: "income",
    category: "rental_income",
    amount: "1200.00",
    paidBy: "kaen",
    createdById: USER,
    updatedById: USER,
    ...over,
  } as never;
}
const createLedger = (over: Record<string, unknown> = {}) =>
  getDb().ownerLedgerEntry.create({ data: ledgerData(over) });
const collection = (over: Record<string, unknown> = {}) =>
  createLedger({ sourceType: "prior_period_collection", sourceChargeId: CHARGE_A, ...over });
const reversal = (over: Record<string, unknown> = {}) =>
  createLedger({ sourceType: "prior_period_collection_reversal", sourceChargeId: CHARGE_A, ...over });
const ledgerCount = (organizationId = ORG) =>
  getDb().ownerLedgerEntry.count({ where: { organizationId } });

async function seedOrg(id: string, slug: string) {
  await getDb().organization.create({
    data: {
      id,
      name: `Closed-Period Schema Org ${slug}`,
      slug,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function wipe() {
  const db = getDb();
  for (const organizationId of [ORG, ORG2]) {
    await db.ownerStatementFreezeManifestRow.deleteMany({ where: { organizationId } });
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId } });
    await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId } });
    await db.ownerLedgerReconciliationRun.deleteMany({ where: { organizationId } });
  }
}

dn("closed-period integrity additive schema (integration)", () => {
  beforeAll(async () => {
    await wipe().catch(() => {});
    await getDb().organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
    await seedOrg(ORG, "c2f0-closed-period-schema");
    await seedOrg(ORG2, "c2f0-closed-period-schema-2");
  });
  afterAll(async () => {
    await wipe();
    await getDb().organization.deleteMany({ where: { id: { in: [ORG, ORG2] } } });
  });
  beforeEach(wipe);

  // ── prior_period_collection under both indexes ──────────────────────────────
  it("B1: two prior_period_collection rows for the SAME charge with distinct alloc events both persist", async () => {
    await collection({ sourceAllocationEventId: ALLOC_1 });
    await collection({ sourceAllocationEventId: ALLOC_2 });
    expect(await ledgerCount()).toBe(2);
  });

  it("B5: two prior_period_collection rows sharing (org, sourceType, sourceAllocationEventId) — 2nd rejected (idempotency key)", async () => {
    await collection({ sourceChargeId: CHARGE_A, sourceAllocationEventId: ALLOC_1 });
    // Different charge, SAME allocation event — must still collide on the alloc-event key.
    await expect(
      collection({ sourceChargeId: CHARGE_B, sourceAllocationEventId: ALLOC_1 }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await ledgerCount()).toBe(1);
  });

  it("M6: two prior_period_collection rows with NULL sourceAllocationEventId (same charge) both persist — DB does NOT guard; app must set the id", async () => {
    await collection({ sourceAllocationEventId: null });
    await collection({ sourceAllocationEventId: null });
    expect(await ledgerCount()).toBe(2);
  });

  // ── prior_period_collection_reversal (2nd excluded type) ────────────────────
  it("M2a: two prior_period_collection_reversal rows for the same charge with distinct alloc events both persist", async () => {
    await reversal({ sourceAllocationEventId: ALLOC_1 });
    await reversal({ sourceAllocationEventId: ALLOC_2 });
    expect(await ledgerCount()).toBe(2);
  });

  it("M2b: two prior_period_collection_reversal rows sharing the alloc-event key — 2nd rejected", async () => {
    await reversal({ sourceChargeId: CHARGE_A, sourceAllocationEventId: ALLOC_1 });
    await expect(
      reversal({ sourceChargeId: CHARGE_B, sourceAllocationEventId: ALLOC_1 }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await ledgerCount()).toBe(1);
  });

  it("M3: a collection and a reversal sharing ONE sourceAllocationEventId both persist (sourceType is part of the key)", async () => {
    await collection({ sourceAllocationEventId: ALLOC_1 });
    await reversal({ sourceAllocationEventId: ALLOC_1 });
    expect(await ledgerCount()).toBe(2);
  });

  // ── partial index still covers the NON-excluded sourceTypes ─────────────────
  it("B2: two prior_period_adjustment rows for the same charge — 2nd rejected (partial index still covers PPA)", async () => {
    await createLedger({ sourceType: "prior_period_adjustment", sourceChargeId: CHARGE_A });
    await expect(
      createLedger({ sourceType: "prior_period_adjustment", sourceChargeId: CHARGE_A }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await ledgerCount()).toBe(1);
  });

  it("B6: two manual rows for the same charge — 2nd rejected (partial index keeps dedup for normal types)", async () => {
    await createLedger({ sourceType: "manual", sourceChargeId: CHARGE_A });
    await expect(
      createLedger({ sourceType: "manual", sourceChargeId: CHARGE_A }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await ledgerCount()).toBe(1);
  });

  it("M1: normal rows (manual+rent) with NULL sourceChargeId + NULL sourceAllocationEventId are unconstrained — all persist", async () => {
    await createLedger({ sourceType: "manual", sourceChargeId: null, sourceAllocationEventId: null });
    await createLedger({ sourceType: "manual", sourceChargeId: null, sourceAllocationEventId: null });
    await createLedger({ sourceType: "rent", sourceChargeId: null, sourceAllocationEventId: null });
    await createLedger({ sourceType: "rent", sourceChargeId: null, sourceAllocationEventId: null });
    expect(await ledgerCount()).toBe(4);
  });

  // ── cross-organization isolation of every new/recreated unique ──────────────
  it("M4: identical alloc-event key AND identical finding key coexist across two orgs (org is the leading column)", async () => {
    await collection({ organizationId: ORG, sourceAllocationEventId: ALLOC_1 });
    await collection({ organizationId: ORG2, ownerPartyId: OWNER, propertyId: PROP, sourceAllocationEventId: ALLOC_1 });
    expect(await ledgerCount(ORG)).toBe(1);
    expect(await ledgerCount(ORG2)).toBe(1);

    const finding = (organizationId: string) =>
      getDb().ownerLedgerReconciliationFinding.create({
        data: {
          organizationId,
          ownerPartyId: OWNER,
          checkKind: "source_to_ledger",
          findingType: "missing_ledger_row",
          sourceType: "charge",
          sourceId: SOURCE_ID,
          severity: "critical",
          lastDetectedAt: new Date(),
        },
      });
    await finding(ORG);
    await finding(ORG2);
    expect(await getDb().ownerLedgerReconciliationFinding.count({ where: { sourceId: SOURCE_ID } })).toBe(2);
  });

  // ── durable reconciliation finding dedupe ───────────────────────────────────
  it("B3: a duplicate reconciliation finding (org, checkKind, sourceType, sourceId, findingType) is rejected", async () => {
    const data = {
      organizationId: ORG,
      ownerPartyId: OWNER,
      checkKind: "source_to_ledger",
      findingType: "missing_ledger_row",
      sourceType: "charge",
      sourceId: SOURCE_ID,
      severity: "critical",
      lastDetectedAt: new Date(),
    };
    await getDb().ownerLedgerReconciliationFinding.create({ data });
    await expect(
      getDb().ownerLedgerReconciliationFinding.create({ data }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await getDb().ownerLedgerReconciliationFinding.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // ── write-once period header + manifest + run persist ───────────────────────
  it("B4: OwnerStatementPeriod write-once header + a freeze-manifest row + a reconciliation run all persist", async () => {
    const db = getDb();
    const frozenAt = new Date("2026-04-01T00:00:00.000Z");
    await db.ownerStatementPeriod.create({
      data: {
        id: PERIOD_B4,
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: MONTH,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:2026-03:b4`,
        sourceMaxUpdatedAt: new Date(),
        firstFrozenAt: frozenAt,
        firstFrozenOpeningC: 0,
        firstFrozenClosingC: 120000,
        firstFrozenNetC: 108000,
        freezeRulesetVersion: 1,
      },
    });
    const period = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: PERIOD_B4 } });
    expect(period.firstFrozenAt?.toISOString()).toBe(frozenAt.toISOString());
    expect(period.firstFrozenClosingC).toBe(120000);
    expect(period.firstFrozenNetC).toBe(108000);
    expect(period.freezeRulesetVersion).toBe(1);

    const manifest = await db.ownerStatementFreezeManifestRow.create({
      data: {
        organizationId: ORG,
        ownerStatementPeriodId: PERIOD_B4,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: MONTH,
        ledgerEntryId: LEDGER_1,
        amountC: 120000,
        direction: "income",
        category: "rental_income",
        paidBy: "kaen",
        includeInPayout: true,
        paymentStatus: "unpaid",
        sstAmountC: null,
        statementMonth: MONTH,
        sourceType: "rent",
        sourceChargeId: CHARGE_A,
        ledgerUpdatedAtAtFreeze: frozenAt,
      },
    });
    expect(manifest.amountC).toBe(120000);
    expect(manifest.includeInPayout).toBe(true);
    expect(manifest.paymentStatus).toBe("unpaid"); // manifest captures unpaid-active rows (snapshotJson omits them)

    const run = await db.ownerLedgerReconciliationRun.create({
      data: {
        organizationId: ORG,
        reconciliationType: "source_to_ledger",
        isFullScope: true,
        triggerType: "manual",
        triggeredById: USER,
      },
    });
    expect(run.status).toBe("running");
    const completed = await db.ownerLedgerReconciliationRun.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: new Date(), sourcesScanned: 7, findingsOpened: 2, findingsResolved: 1 },
    });
    expect(completed.status).toBe("completed");
    expect(completed.sourcesScanned).toBe(7);
    expect(completed.findingsOpened).toBe(2);
    expect(completed.completedAt).not.toBeNull();
  });

  // ── FK onDelete Cascade: period delete removes manifest rows ─────────────────
  it("B7: deleting an OwnerStatementPeriod cascades its freeze-manifest rows", async () => {
    const db = getDb();
    await db.ownerStatementPeriod.create({
      data: {
        id: PERIOD_B7,
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: MONTH,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:2026-03:b7`,
        sourceMaxUpdatedAt: new Date(),
      },
    });
    await db.ownerStatementFreezeManifestRow.create({
      data: {
        organizationId: ORG,
        ownerStatementPeriodId: PERIOD_B7,
        ownerPartyId: OWNER,
        periodMonth: MONTH,
        ledgerEntryId: LEDGER_1,
        amountC: 5000,
        direction: "expense",
        category: "cleaning",
        paidBy: "kaen",
        includeInPayout: true,
        paymentStatus: "paid",
        statementMonth: MONTH,
        sourceType: "rent",
        ledgerUpdatedAtAtFreeze: new Date(),
      },
    });
    expect(await db.ownerStatementFreezeManifestRow.count({ where: { ownerStatementPeriodId: PERIOD_B7 } })).toBe(1);
    await db.ownerStatementPeriod.delete({ where: { id: PERIOD_B7 } });
    expect(await db.ownerStatementFreezeManifestRow.count({ where: { ownerStatementPeriodId: PERIOD_B7 } })).toBe(0);
  });
});
