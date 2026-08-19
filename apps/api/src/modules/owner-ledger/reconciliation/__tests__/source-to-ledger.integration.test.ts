/**
 * source-to-ledger.integration.test.ts — R5 Reconciliation Check #1.
 *
 * For each owner-impacting Charge (owner units/carparks) and charged UnitUtilityBill
 * billed into a FROZEN month, assert the owner-ledger identity
 *   current_effective_allocated(charge) == frozen_collected
 *     + Σ prior_period_collection − Σ prior_period_collection_reversal
 * and that a valid normal (or prior_period_adjustment) ledger row exists. Emits
 * durable findings (missing_ledger_row / stale_collected_amount /
 * invalid_forward_adjustment), auto-resolving on repair. READ-ONLY w.r.t. money.
 *
 * Runs INDEPENDENT of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (spec R10): this
 * suite deliberately leaves that flag UNSET and still produces findings.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/source-to-ledger.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { syncMonthService } from "../../owner-ledger.sync";
import { postPriorPeriodCollections } from "../../prior-period-collection";
import { freezeStatementPeriod } from "../../../owner-billing/owner-statement-period.service";
import { runSourceToLedger } from "../source-to-ledger";
import type { OwnerLedgerActorCtx } from "../../owner-ledger.types";
import type { OwnerBillingActorCtx } from "../../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 5e10; unused by any other suite) ───────────────
const ORG = "5e100000-0000-4000-8000-000000000001";
const USER = "5e100000-0000-4000-8000-000000000002";
const OWNER = "5e100000-0000-4000-8000-000000000003";
const TENANT = "5e100000-0000-4000-8000-000000000004";
const PROP = "5e100000-0000-4000-8000-000000000005";
const APT = "5e100000-0000-4000-8000-000000000006";
const UNIT = "5e100000-0000-4000-8000-000000000007";
const TEN = "5e100000-0000-4000-8000-000000000008";
const C_SEED = "5e100000-0000-4000-8000-000000000009";
const C_MISS = "5e100000-0000-4000-8000-00000000000a";
const C_STALE = "5e100000-0000-4000-8000-00000000000b";
const C_MGMT = "5e100000-0000-4000-8000-00000000000c";
const C_PPA = "5e100000-0000-4000-8000-00000000000d";
const OWNER2 = "5e100000-0000-4000-8000-0000000000b2";
// Statement-expense (Source-2) fixtures — owner_statement Invoice + child charges.
const INV_STMT = "5e100000-0000-4000-8000-0000000000c1";
const C_STMT_MGMT = "5e100000-0000-4000-8000-0000000000c2";
const C_STMT_CLEAN = "5e100000-0000-4000-8000-0000000000c3";
const C_STMT_MAINT = "5e100000-0000-4000-8000-0000000000c4";
const C_STMT_TNB = "5e100000-0000-4000-8000-0000000000c5";
const C_STMT_VOID = "5e100000-0000-4000-8000-0000000000c6";
const C_STMT_CRED = "5e100000-0000-4000-8000-0000000000c7";
// Seam #1 (payout netting) fixtures — an active charge-backed CN on a statement charge.
const SERIES_CN = "5e100000-0000-4000-8000-0000000000d1";
const C_STMT_ADJ = "5e100000-0000-4000-8000-0000000000d2";
const CN_DOC_ADJ = "5e100000-0000-4000-8000-0000000000d3";

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

const NOW = new Date();
const curStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const ym = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const FROZEN_M = ym(frozenStart);
const frozenDue = new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), 5));
const RECEIVED = new Date(Date.UTC(curStart.getUTCFullYear(), curStart.getUTCMonth(), 10));

let payCounter = 0;

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.carpark.deleteMany({ where: org });
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
      id: ORG, name: "5E10 Source-To-Ledger Org", slug: "5e10-source-to-ledger-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "5e10@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "5E10 Admin" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "S2L Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "S2L Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "S2L Tower", propertyCode: "S2L-P1", propertyType: "apartment", addressLine1: "1 S2L St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "S2L-01-01", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "S2L-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2025, 0, 1)), monthlyRentAmount: "800" } });
}

async function makeRentCharge(o: { id: string; status: string; amount: string; outstanding: string; number: string }) {
  return getDb().charge.create({
    data: {
      id: o.id, organizationId: ORG, chargeNumber: o.number, partyId: TENANT, tenancyId: TEN, unitId: UNIT,
      chargeType: "rent", status: o.status, postedAt: new Date(), dueDate: frozenDue, amount: o.amount,
      currency: "MYR", outstandingAmount: o.outstanding, billingMonth: frozenStart,
    },
  });
}

async function payCharge(o: { chargeId: string; amount: string; createdAt: Date }): Promise<string> {
  const db = getDb();
  const paymentId = randomUUID();
  await db.payment.create({ data: { id: paymentId, organizationId: ORG, paymentNumber: `S2L-PAY-${++payCounter}`, partyId: TENANT, paymentType: "tenant_payment", // "posted" is the only status meaning money arrived; "completed" is written nowhere in production.
    paymentMethod: "bank_transfer", status: "posted", amount: o.amount, currency: "MYR", receivedAt: RECEIVED } });
  const allocId = randomUUID();
  await db.paymentAllocation.create({ data: { id: allocId, organizationId: ORG, paymentId, chargeId: o.chargeId, allocatedAmount: o.amount, allocatedAt: RECEIVED, createdAt: o.createdAt } });
  return allocId;
}

/** Seed one paid rent charge, sync it, and freeze the period (so a frozen period + manifest exist). */
async function seedFrozenPeriodWithPaidRent() {
  await makeRentCharge({ id: C_SEED, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-SEED" });
  await payCharge({ chargeId: C_SEED, amount: "800.00", createdAt: frozenDue }); // pre-freeze cash
  await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
  const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
  return frozen;
}

/** Create an owner_statement Invoice for the frozen month with child charges (Source-2). */
async function makeStatement(o: {
  invoiceId: string;
  status?: string;
  sstAmount?: string | null;
  charges: Array<{ id: string; chargeType: string; amount: string; status?: string; number: string }>;
}) {
  const db = getDb();
  const key = o.invoiceId.slice(-4);
  await db.invoice.create({
    data: {
      id: o.invoiceId, organizationId: ORG, invoiceNumber: `S2L-INV-${key}`, partyId: OWNER, ownerPartyId: OWNER,
      propertyId: PROP, invoiceType: "owner_statement", status: o.status ?? "draft", invoiceDate: frozenStart,
      periodMonth: frozenStart, totalAmount: "0.00", sstAmount: o.sstAmount ?? null, currency: "MYR",
      idempotencyKey: `owner:${OWNER}:${FROZEN_M}:${key}`,
    },
  });
  for (const c of o.charges) {
    await db.charge.create({
      data: {
        id: c.id, organizationId: ORG, chargeNumber: c.number, unitId: UNIT, partyId: OWNER, chargeType: c.chargeType,
        status: c.status ?? "posted", postedAt: new Date(), dueDate: frozenDue, amount: c.amount, currency: "MYR",
        outstandingAmount: c.amount, invoiceId: o.invoiceId, billingMonth: frozenStart,
      },
    });
  }
}

/**
 * Mint an ACTIVE charge-backed credit_note against a statement charge — the
 * DB effect createChargeAdjustmentService produces for a note line
 * (charge-adjustment.service.ts:288-308). Netted by netAdjustmentsByChargeId
 * (seam #1) regardless of `originalDocumentId`, which that helper never
 * filters on. Caller must have created the CN DocumentSeries (id SERIES_CN) first.
 */
async function mintChargeCreditNote(o: { id: string; chargeId: string; amount: string; number: string }) {
  const db = getDb();
  await db.billingDocument.create({
    data: {
      id: o.id, organizationId: ORG, docType: "credit_note", documentNumber: o.number,
      seriesId: SERIES_CN, status: "issued", issuedById: USER, counterpartyType: "owner",
      partyId: OWNER, originalDocumentId: INV_STMT, creditAmount: "0.00",
      subtotal: o.amount, sstAmount: "0", total: o.amount,
      lines: { create: [{ chargeId: o.chargeId, description: "Correction: Management fee", amount: o.amount, sstRate: 0, sstAmount: 0 }] },
    },
  });
}

const findingsFor = (sourceId: string) =>
  getDb().ownerLedgerReconciliationFinding.findMany({ where: { organizationId: ORG, checkKind: "source_to_ledger", sourceId } });

dn("runSourceToLedger — source-to-ledger reconciliation (R5, integration)", () => {
  let savedLedger: string | undefined;
  beforeAll(() => {
    // Prove flag-INDEPENDENCE (spec R10): R5 runs with LIVE_LEDGER explicitly UNSET.
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
  });
  afterAll(async () => {
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    payCounter = 0;
    await cleanup();
    await seedBase();
  });

  // ── S1: a backdated owner charge with no ledger row → missing_ledger_row ──────────
  it("S1: an owner charge in a frozen month with no active ledger row opens a critical missing_ledger_row finding", async () => {
    await seedFrozenPeriodWithPaidRent();
    // A NEW rent charge backdated into the frozen month, never synced → no ledger row (Family 1 drop).
    await makeRentCharge({ id: C_MISS, status: "posted", amount: "500.00", outstanding: "500.00", number: "S2L-MISS" });

    expect(process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER).toBeUndefined(); // flag-independent

    await runSourceToLedger(ledgerCtx, {});

    const miss = await findingsFor(C_MISS);
    expect(miss).toHaveLength(1);
    expect(miss[0]!.findingType).toBe("missing_ledger_row");
    expect(miss[0]!.severity).toBe("critical");
    expect(miss[0]!.status).toBe("open");
    expect(miss[0]!.sourceType).toBe("rent");
    expect(miss[0]!.ownerPartyId).toBe(OWNER);
    expect(miss[0]!.originalBillingMonth!.getTime()).toBe(frozenStart.getTime());

    // The seeded charge that DOES have a row is not flagged.
    expect(await findingsFor(C_SEED)).toHaveLength(0);
  });

  // ── S2: frozen rent collected=0 now fully paid, no forward → stale_collected_amount ─
  it("S2: a frozen rent row (collected 0) whose charge is now fully paid with no prior_period_collection opens a critical stale_collected_amount", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-STALE" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // normal row, collected 0
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Tenant pays in full AFTER freeze, but NO prior_period_collection is posted (the bug).
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });

    await runSourceToLedger(ledgerCtx, {});

    const stale = await findingsFor(C_STALE);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.findingType).toBe("stale_collected_amount");
    expect(stale[0]!.severity).toBe("critical");
    expect(stale[0]!.status).toBe("open");
    expect(stale[0]!.expectedAmountC).toBe(80000); // current effective allocated cents
    expect(stale[0]!.actualAmountC).toBe(0); // frozen collected (manifest) + Σ forward = 0
  });

  // ── S3: forward posted → a re-run auto-resolves the stale finding ────────────────
  it("S3: after prior_period_collection is posted, a re-run AUTO-RESOLVES the stale_collected_amount finding", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-S3" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });

    await runSourceToLedger(ledgerCtx, {});
    expect((await findingsFor(C_STALE))[0]!.status).toBe("open"); // stale opened

    // R3 posts the forward collection → the identity is now satisfied.
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M);
    await runSourceToLedger(ledgerCtx, {}); // re-scan

    const after = await findingsFor(C_STALE);
    expect(after).toHaveLength(1); // same row (not duplicated)
    expect(after[0]!.status).toBe("resolved"); // auto-resolved on repair
    expect(after[0]!.resolvedAt).not.toBeNull();
  });

  // ── S4: a valid forward set satisfying the identity → NO finding ─────────────────
  it("S4: a valid prior_period_collection set satisfying the identity produces NO finding", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-S4" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });
    await postPriorPeriodCollections(ledgerCtx, OWNER, FROZEN_M); // forward posted correctly

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STALE)).toHaveLength(0);
  });

  // ── S6: no frozen periods → trivially clean (flag-independent, spec R10) ──────────
  it("S6: with no frozen periods the run scans nothing and opens no findings", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-S6" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // synced but NOT frozen

    const res = await runSourceToLedger(ledgerCtx, {});
    expect(res.sourcesScanned).toBe(0);
    expect(await db.ownerLedgerReconciliationFinding.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── S7: a void/credited charge in the frozen month is NOT flagged missing ────────
  it("S7: a void charge backdated into the frozen month is not flagged missing (sync skips void/credited)", async () => {
    await seedFrozenPeriodWithPaidRent();
    await makeRentCharge({ id: C_MISS, status: "void", amount: "500.00", outstanding: "500.00", number: "S2L-VOID" });
    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_MISS)).toHaveLength(0);
  });

  // ── S8: an unpaid frozen rent row still unpaid → identity 0==0 → NO finding ───────
  it("S8: an unpaid frozen rent row whose charge is still unpaid produces NO stale finding (identity 0==0)", async () => {
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-S8" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    // No payment — charge remains unpaid.
    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STALE)).toHaveLength(0);
  });

  // ── S_SPOOF: frozen_collected comes from the MANIFEST, not the mutable live row ───
  it("S_SPOOF: editing the live frozen row's amount to mask the shortfall still opens stale (manifest-sourced)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-SPOOF" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });
    // TAMPER: bump the live frozen row to 800 (would spoof the identity if R5 read it live).
    await db.ownerLedgerEntry.update({ where: { id: normal.id }, data: { amount: "800.00", paymentStatus: "paid" } });

    await runSourceToLedger(ledgerCtx, {});
    const stale = await findingsFor(C_STALE);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.findingType).toBe("stale_collected_amount");
    expect(stale[0]!.actualAmountC).toBe(0); // manifest frozen_collected 0, NOT the tampered live 80000
  });

  // ── S_PARTIAL: exact-cent identity from a partial baseline with a 1-cent forward gap ─
  it("S_PARTIAL: a partial-at-freeze charge completed with a 1-cent forward shortfall opens stale (no cent drift)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "partially_paid", amount: "1000.00", outstanding: "700.00", number: "S2L-PART" });
    await payCharge({ chargeId: C_STALE, amount: "300.00", createdAt: frozenDue }); // pre-freeze collected 300
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    expect(Number(normal.amount.toString())).toBe(300);
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_STALE, amount: "700.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) }); // effective allocated now 1000
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });
    // A BUGGY forward posts only 699.99 (1 cent short of the 700 owed).
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId,
        listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED,
        direction: "income", category: normal.category, amount: "699.99", paidBy: normal.paidBy, paymentStatus: "paid",
        includeInPayout: normal.includeInPayout, sourceType: "prior_period_collection", sourceChargeId: C_STALE,
        sourceAllocationEventId: randomUUID(), status: "active", createdById: USER, updatedById: USER,
      },
    });

    await runSourceToLedger(ledgerCtx, {});
    const stale = await findingsFor(C_STALE);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.expectedAmountC).toBe(100000); // effective allocated 1000.00
    expect(stale[0]!.actualAmountC).toBe(99999); // frozen 300.00 + forward 699.99
    expect(stale[0]!.expectedAmountC! - stale[0]!.actualAmountC!).toBe(1); // exactly one cent, no float drift
  });

  // ── S_EXP: an EXPENSE charge is never subject to the collected identity ───────────
  it("S_EXP: a frozen unpaid EXPENSE (management_fee) charge produces no finding (expense not income-collected)", async () => {
    const db = getDb();
    await db.charge.create({
      data: { id: C_MGMT, organizationId: ORG, chargeNumber: "S2L-MGMT", partyId: OWNER, unitId: UNIT, chargeType: "management_fee", status: "posted", postedAt: new Date(), dueDate: frozenDue, amount: "108.00", currency: "MYR", outstandingAmount: "108.00", billingMonth: frozenStart },
    });
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: frozenStart, transactionDate: frozenStart, direction: "expense", category: "management_fee", amount: "108.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true, sourceType: "statement", sourceChargeId: C_MGMT, status: "active", createdById: USER, updatedById: USER },
    });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_MGMT)).toHaveLength(0); // full-amount expense, unpaid → NOT flagged
  });

  // ── S_SCOPE: a scoped run must NOT auto-resolve an out-of-scope finding ───────────
  it("S_SCOPE: a run scoped to owner A does not auto-resolve owner B's open finding (scope containment)", async () => {
    const db = getDb();
    const FAKE_SRC = "5e100000-0000-4000-8000-0000000000f1";
    // A REAL open critical finding for a DIFFERENT owner, same org, that this run never scans.
    await db.ownerLedgerReconciliationFinding.create({
      data: { organizationId: ORG, ownerPartyId: OWNER2, checkKind: "source_to_ledger", findingType: "missing_ledger_row", sourceType: "rent", sourceId: FAKE_SRC, severity: "critical", status: "open", lastDetectedAt: new Date(), originalBillingMonth: frozenStart },
    });
    await seedFrozenPeriodWithPaidRent(); // owner A: clean frozen period

    await runSourceToLedger(ledgerCtx, { ownerPartyId: OWNER }); // scoped to owner A only

    const b = await db.ownerLedgerReconciliationFinding.findFirstOrThrow({ where: { organizationId: ORG, ownerPartyId: OWNER2, sourceId: FAKE_SRC } });
    expect(b.status).toBe("open"); // untouched — a global auto-resolve would have wrongly resolved it
  });

  // ── S_PPA_VALID: a backdated charge covered by a valid prior_period_adjustment ────
  it("S_PPA_VALID: a backdated charge with a valid prior_period_adjustment entry produces NO finding", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    // A backdated, fully-paid rent charge with NO normal row but a VALID PPA in the OPEN month.
    await makeRentCharge({ id: C_PPA, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-PPA-OK" });
    await payCharge({ chargeId: C_PPA, amount: "800.00", createdAt: RECEIVED });
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: curStart, transactionDate: RECEIVED, direction: "income", category: "rental_income", amount: "800.00", paidBy: "kaen", paymentStatus: "paid", includeInPayout: true, sourceType: "prior_period_adjustment", sourceChargeId: C_PPA, status: "active", createdById: USER, updatedById: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_PPA)).toHaveLength(0); // valid PPA → neither missing nor invalid
  });

  // ── S_PPA_INVALID: a mismatched prior_period_adjustment → invalid_forward_adjustment ─
  it("S_PPA_INVALID: a backdated charge whose prior_period_adjustment amount mismatches opens a critical invalid_forward_adjustment", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    await makeRentCharge({ id: C_PPA, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-PPA-BAD" });
    await payCharge({ chargeId: C_PPA, amount: "800.00", createdAt: RECEIVED });
    // A PPA that UNDER-books the owner (500 instead of 800) — silently mispays.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: curStart, transactionDate: RECEIVED, direction: "income", category: "rental_income", amount: "500.00", paidBy: "kaen", paymentStatus: "paid", includeInPayout: true, sourceType: "prior_period_adjustment", sourceChargeId: C_PPA, status: "active", createdById: USER, updatedById: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const f = await findingsFor(C_PPA);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("invalid_forward_adjustment");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.sourceType).toBe("prior_period_adjustment");
    expect(f[0]!.expectedAmountC).toBe(80000);
    expect(f[0]!.actualAmountC).toBe(50000);
  });

  // ── S10: a charged UnitUtilityBill category with no ledger row → missing_ledger_row ─
  it("S10: a charged utility bill category with a positive amount and no active ledger row opens missing_ledger_row", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    // A CHARGED bill backdated into the frozen month, never synced → no utility ledger row.
    await db.unitUtilityBill.create({
      data: { organizationId: ORG, apartmentId: APT, periodMonth: frozenStart, billingMode: "whole", tnbTotal: "150.00", airSelangor: "0", indahWater: "0", cleaning: "0", status: "charged", createdBy: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const bill = await db.unitUtilityBill.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    const f = await findingsFor(bill.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("missing_ledger_row");
    expect(f[0]!.sourceType).toBe("utility_tnb");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(15000);
    expect(f[0]!.expectedDirection).toBe("expense");
  });

  // ── S10_NEG: a DRAFT bill / zero-amount category is legitimately unbooked → no finding ─
  it("S10_NEG: a draft bill and a zero-amount category produce no missing_ledger_row", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    // A DRAFT bill (not yet charged) with a positive TNB, and a zero water — neither booked by the sync.
    await db.unitUtilityBill.create({
      data: { organizationId: ORG, apartmentId: APT, periodMonth: frozenStart, billingMode: "whole", tnbTotal: "150.00", airSelangor: "0", indahWater: "0", cleaning: "0", status: "draft", createdBy: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const bill = await db.unitUtilityBill.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    expect(await findingsFor(bill.id)).toHaveLength(0); // draft → not a source; zero category → nothing expected
  });

  // ── S_ISO (Bug 3 — I1 fail-open auto-resolve): a per-period scan THROW in a ────────
  // full-scope run must NOT auto-resolve that period's open critical finding. The
  // pre-fix code kept a run-global emittedKeys + a single end-of-run autoResolveStale
  // scoped only by the run filter: a period whose scan threw left its keys un-emitted,
  // so a full-scope run wrongly RESOLVED its (still-real) criticals → preflight
  // false-pass. Fix mirrors frozen-integrity: per-period emittedKeys + autoResolve
  // INSIDE the per-period try (skipped entirely when that period throws).
  it("S_ISO: a period whose scan throws does not have its open critical finding auto-resolved", async () => {
    const db = getDb();
    // A real stale condition (paid-after-freeze, no forward) → opens a critical finding.
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-ISO" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "paid", outstandingAmount: "0.00" } });

    await runSourceToLedger(ledgerCtx, {}); // run 1 opens it
    expect((await findingsFor(C_STALE))[0]!.status).toBe("open");

    // Run 2 (FULL scope): force THIS period's scan to throw before it can re-emit — the
    // normal-row lookup for C_STALE throws, aborting the period's scan. Patch findFirst by
    // direct save/restore rather than vi.spyOn: the Prisma model delegate is proxy-served, so
    // vi.spyOn(...).mockRestore() leaves findFirst `undefined` — a latent leak that silently
    // breaks the NEXT findFirst-using test in the file. A manual reassign restores the exact
    // original reference.
    const realFindFirst = db.ownerLedgerEntry.findFirst.bind(db.ownerLedgerEntry);
    db.ownerLedgerEntry.findFirst = ((args: Parameters<typeof realFindFirst>[0]) => {
      if (JSON.stringify(args?.where ?? {}).includes(C_STALE)) throw new Error("injected per-period scan failure");
      return realFindFirst(args);
    }) as typeof db.ownerLedgerEntry.findFirst;
    try {
      await runSourceToLedger(ledgerCtx, {});
    } finally {
      db.ownerLedgerEntry.findFirst = realFindFirst as typeof db.ownerLedgerEntry.findFirst;
    }

    // The still-broken finding must remain OPEN — a throwing period's criticals are never
    // silently resolved (fail-closed).
    const after = await findingsFor(C_STALE);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("open");
    expect(after[0]!.resolvedAt).toBeNull();
  });

  // ── S_ORPH (safety net, review C1): a VOID/credited frozen-month charge carrying an ─
  // ORPHANED prior_period_collection (the pre-fix Bug-1 leak, or any drifted forward
  // flow) over-credits the owner. The income-charge loop skips void/credited, so R5's
  // void-scan must catch it: booked (frozen + Σppc − Σppc_reversal − Σreversal) must stay
  // within [0, current_effective_allocated]; booked > effAlloc = over-credit.
  it("S_ORPH: a void charge with an orphaned prior_period_collection opens a critical orphaned_forward_collection", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-ORPH" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;

    // Paid post-freeze (alloc), then bounced (reversal), then voided — effective allocated 0.
    const allocId = await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.paymentAllocationReversal.create({ data: { id: randomUUID(), organizationId: ORG, originalAllocationId: allocId, amount: "800.00", reason: "bounce", reversedById: USER, createdAt: new Date(firstFrozenAt.getTime() + 120_000), idempotencyKey: `ORPH-${randomUUID()}` } });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "void", outstandingAmount: "800.00" } });
    // A +800 forward collection was posted but the compensating reversal is MISSING.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId, listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED, direction: "income", category: normal.category, amount: "800.00", paidBy: normal.paidBy, paymentStatus: "paid", includeInPayout: normal.includeInPayout, sourceType: "prior_period_collection", sourceChargeId: C_STALE, sourceAllocationEventId: allocId, status: "active", createdById: USER, updatedById: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const f = await findingsFor(C_STALE);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("orphaned_forward_collection");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(0); // current effective allocated (800 − 800)
    expect(f[0]!.actualAmountC).toBe(80000); // booked forward+frozen (0 + 800)
  });

  // ── S_ORPH_NEG: the CORRECT fixed state (ppc + compensating ppc_reversal net 0) on a ─
  // void charge is within [0, effAlloc] → NO finding (the void-scan never false-flags the
  // fix output; S7 already covers a void charge with no forward rows).
  it("S_ORPH_NEG: a void charge whose forward collection is correctly compensated opens no finding", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-ORPHN" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    const allocId = await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.paymentAllocationReversal.create({ data: { id: randomUUID(), organizationId: ORG, originalAllocationId: allocId, amount: "800.00", reason: "bounce", reversedById: USER, createdAt: new Date(firstFrozenAt.getTime() + 120_000), idempotencyKey: `ORPHN-${randomUUID()}` } });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "void", outstandingAmount: "800.00" } });
    const base = { organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId, listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED, category: normal.category, paidBy: normal.paidBy, paymentStatus: "paid", includeInPayout: normal.includeInPayout, sourceChargeId: C_STALE, status: "active", createdById: USER, updatedById: USER };
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "income", amount: "800.00", sourceType: "prior_period_collection", sourceAllocationEventId: allocId } });
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "expense", amount: "800.00", sourceType: "prior_period_collection_reversal", sourceAllocationEventId: randomUUID() } });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STALE)).toHaveLength(0); // booked 0, effAlloc 0 → in range
  });

  // ── S_MASK (SEMANTIC FLIP under the holdback rule): the exact state that pre-fix was a ─
  // "stale double-reversal" bug is now the CORRECT holdback. A void charge, paid pre-freeze
  // (frozen 800), whose pre-freeze payment bounces post-freeze (ppc_reversal −800) and is
  // re-paid post-freeze and RETAINED (ppc +800), then carries a full holdback reversal −800:
  //   booked = frozen 800 + Σppc 800 − Σppc_reversal 800 − Σreversal 800 = 0.
  // Owner income nets to 0 — correct, because a void charge earns the owner nothing and the
  // retained 800 is the tenant's credit. Under the OLD identity (targetRev = frozen − Σppc_rev
  // = 0) the −800 reversal read as a stale double-reversal → finding. Under the holdback
  // identity (targetRev = frozen + Σppc − Σppc_rev = 800 == revC) it is exactly right → NO
  // finding. (The masked over-credit direction — a MISSING holdback on a retained collection —
  // is now covered by S_HOLDBACK_MISSING.)
  it("S_MASK: a void charge whose retained post-freeze collection is correctly held back (net 0) opens no finding", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-MASK" });
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: frozenDue }); // alloc#1 pre-freeze
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    const alloc1 = (await db.paymentAllocation.findFirstOrThrow({ where: { organizationId: ORG, chargeId: C_STALE } })).id;
    // alloc#1 reversed post-freeze; alloc#2 (retained) post-freeze → effAlloc = 800.
    await db.paymentAllocationReversal.create({ data: { id: randomUUID(), organizationId: ORG, originalAllocationId: alloc1, amount: "800.00", reason: "bounce", reversedById: USER, createdAt: new Date(firstFrozenAt.getTime() + 60_000), idempotencyKey: `MASK-${randomUUID()}` } });
    await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 90_000) }); // alloc#2 retained
    await db.charge.update({ where: { id: C_STALE }, data: { status: "void", outstandingAmount: "0.00" } });
    // Seed the CORRECT held-back state: ppc +800, ppc_reversal −800, holdback reversal −800.
    const base = { organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId, listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED, category: normal.category, paidBy: normal.paidBy, paymentStatus: "paid", includeInPayout: normal.includeInPayout, sourceChargeId: C_STALE, status: "active", createdById: USER, updatedById: USER };
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "income", amount: "800.00", sourceType: "prior_period_collection", sourceAllocationEventId: randomUUID() } });
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "expense", amount: "800.00", sourceType: "prior_period_collection_reversal", sourceAllocationEventId: randomUUID() } });
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "expense", amount: "800.00", sourceType: "reversal", sourceAllocationEventId: null } });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STALE)).toHaveLength(0); // owner income net 0 → correctly held back
  });

  // ── S_HOLDBACK_MISSING (holdback rule — Case B fail-closed): a VOID charge that ─────
  // collected cash post-freeze (prior_period_collection +800) which is RETAINED (no
  // PaymentAllocationReversal → effAlloc stays 800) but has NO holdback `reversal` row.
  // The owner still recognises 800 for a void charge — over-credit. The cash-conservation
  // BAND passes (booked 800 == effAlloc 800), so ONLY the exact reversal identity
  // revC == max(0, frozen + Σppc − Σppc_reversal) catches it. This is the exact orphan the
  // pre-fix identity (which omitted +Σppc) missed → the R5 fail-closed detector.
  it("S_HOLDBACK_MISSING: a void charge with a retained post-freeze collection and no holdback reversal opens orphaned_forward_collection", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-HBMISS" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // frozen normal collected 0
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    // Paid in full AFTER freeze and RETAINED (no reversal) → effective allocated 800.
    const allocId = await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "void", outstandingAmount: "800.00" } });
    // A +800 forward collection posted, but NO holdback reversal → owner over-credited 800.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId, listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED, direction: "income", category: normal.category, amount: "800.00", paidBy: normal.paidBy, paymentStatus: "paid", includeInPayout: normal.includeInPayout, sourceType: "prior_period_collection", sourceChargeId: C_STALE, sourceAllocationEventId: allocId, status: "active", createdById: USER, updatedById: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const f = await findingsFor(C_STALE);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("orphaned_forward_collection");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(80000); // effAlloc 800 (retained)
    expect(f[0]!.actualAmountC).toBe(80000); // booked 800 == effAlloc → the BAND cannot tell; the identity does
  });

  // ── S_HOLDBACK_OK (holdback rule — correct state → NO false positive): the exact state ─
  // the fixed sync produces for a Case-B void: frozen 0 + prior_period_collection +800 +
  // holdback reversal −800 → owner income nets to 0. Must NOT open a finding (else the R5
  // detector would false-flag the correct fix output). Pre-fix this false-flagged because
  // the identity omitted +Σppc (targetRev computed as 0, but revC is 800).
  it("S_HOLDBACK_OK: a void charge correctly held back (ppc +800, holdback reversal −800, net 0) opens no finding", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_STALE, status: "posted", amount: "800.00", outstanding: "800.00", number: "S2L-HBOK" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const normal = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "rent", sourceChargeId: C_STALE } });
    const frozen = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    const allocId = await payCharge({ chargeId: C_STALE, amount: "800.00", createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await db.charge.update({ where: { id: C_STALE }, data: { status: "void", outstandingAmount: "800.00" } });
    const base = { organizationId: ORG, ownerPartyId: OWNER, propertyId: normal.propertyId, apartmentId: normal.apartmentId, listingId: normal.listingId, tenancyId: normal.tenancyId, statementMonth: curStart, transactionDate: RECEIVED, category: normal.category, paidBy: normal.paidBy, paymentStatus: "paid", includeInPayout: normal.includeInPayout, sourceChargeId: C_STALE, status: "active", createdById: USER, updatedById: USER };
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "income", amount: "800.00", sourceType: "prior_period_collection", sourceAllocationEventId: allocId } });
    await db.ownerLedgerEntry.create({ data: { ...base, direction: "expense", amount: "800.00", sourceType: "reversal", sourceAllocationEventId: null } });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STALE)).toHaveLength(0); // net 0 → correctly held back, no finding
  });

  // ── S_STMT_MISS (statement-expense source coverage): an owner_statement expense child ─
  // charge (management_fee) that failed to book its owner-ledger row is a Family-1 drop the
  // OLD R5 could not see (it excluded statement expenses). Now R5 re-derives the expected
  // statement rows via the sync's own expectedStatementLedgerRows and opens a critical
  // missing_ledger_row; once the row is booked, a re-run AUTO-RESOLVES it.
  it("S_STMT_MISS: a statement management_fee charge with no active ledger row opens missing_ledger_row, then auto-resolves once booked", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    // A backdated owner_statement Invoice + management_fee child charge, never synced → no ledger row.
    await makeStatement({
      invoiceId: INV_STMT,
      charges: [{ id: C_STMT_MGMT, chargeType: "management_fee", amount: "108.00", number: "S2L-STMT-MGMT" }],
    });

    await runSourceToLedger(ledgerCtx, {});
    const miss = await findingsFor(C_STMT_MGMT);
    expect(miss).toHaveLength(1);
    expect(miss[0]!.findingType).toBe("missing_ledger_row");
    expect(miss[0]!.severity).toBe("critical");
    expect(miss[0]!.status).toBe("open");
    expect(miss[0]!.sourceType).toBe("statement");
    expect(miss[0]!.expectedDirection).toBe("expense");
    expect(miss[0]!.expectedAmountC).toBe(10800);
    expect(miss[0]!.originalBillingMonth!.getTime()).toBe(frozenStart.getTime());

    // Book the expected statement ledger row → a re-run AUTO-RESOLVES the finding.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: frozenStart, transactionDate: frozenStart, direction: "expense", category: "management_fee", amount: "108.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true, sourceType: "statement", sourceChargeId: C_STMT_MGMT, sourceInvoiceId: INV_STMT, status: "active", createdById: USER, updatedById: USER },
    });
    await runSourceToLedger(ledgerCtx, {});
    const after = await findingsFor(C_STMT_MGMT);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("resolved");
    expect(after[0]!.resolvedAt).not.toBeNull();
  });

  // ── S_STMT_OK (correctly-booked + display-only): a statement whose KEPT expense rows ─
  // (management_fee carrying the single aggregate SST, cleaning, maintenance) are all booked
  // by the sync must produce NO finding — AND a display-only utility line (tnb) that the sync
  // intentionally does NOT materialize (the Source-3 full bill is its sole payout source) must
  // NOT be flagged missing. Booked via the REAL sync so R5's expected-rows exactly match what
  // the sync produces (shared expectedStatementLedgerRows).
  it("S_STMT_OK: a correctly-booked statement (mgmt_fee+SST, cleaning, maintenance) with a display-only tnb line opens NO finding", async () => {
    await makeRentCharge({ id: C_SEED, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-OK-RENT" });
    await payCharge({ chargeId: C_SEED, amount: "800.00", createdAt: frozenDue });
    await makeStatement({
      invoiceId: INV_STMT,
      sstAmount: "6.48",
      charges: [
        { id: C_STMT_MGMT, chargeType: "management_fee", amount: "108.00", number: "S2L-OK-MGMT" },
        { id: C_STMT_CLEAN, chargeType: "cleaning", amount: "100.00", number: "S2L-OK-CLEAN" },
        { id: C_STMT_MAINT, chargeType: "maintenance", amount: "50.00", number: "S2L-OK-MAINT" },
        { id: C_STMT_TNB, chargeType: "tnb", amount: "75.00", number: "S2L-OK-TNB" }, // display-only → sync skips
      ],
    });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // books mgmt_fee(SST)/cleaning/maintenance; skips tnb
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STMT_MGMT)).toHaveLength(0); // booked (incl. SST) → not flagged
    expect(await findingsFor(C_STMT_CLEAN)).toHaveLength(0);
    expect(await findingsFor(C_STMT_MAINT)).toHaveLength(0);
    expect(await findingsFor(C_STMT_TNB)).toHaveLength(0); // display-only, sync did NOT book → must NOT false-flag
  });

  // ── S_STMT_VOID_CHILD: a VOID and a CREDITED owner_statement child charge book NO ledger ─
  // row (the sync excludes void/credited children), so R5 must NOT flag them missing — it
  // mirrors the sync's child-status filter when enumerating expected statement rows.
  it("S_STMT_VOID_CHILD: void/credited statement child charges are not flagged missing", async () => {
    await seedFrozenPeriodWithPaidRent();
    await makeStatement({
      invoiceId: INV_STMT,
      charges: [
        { id: C_STMT_VOID, chargeType: "management_fee", amount: "108.00", status: "void", number: "S2L-VOID-MGMT" },
        { id: C_STMT_CRED, chargeType: "cleaning", amount: "100.00", status: "credited", number: "S2L-CRED-CLEAN" },
      ],
    });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STMT_VOID)).toHaveLength(0); // void child → sync skips → not expected
    expect(await findingsFor(C_STMT_CRED)).toHaveLength(0); // credited child → sync skips → not expected
  });

  // ── S_STMT_VOID_INVOICE: a whole owner_statement Invoice voided (status:void) books NO ─
  // rows (the sync excludes void statements and its reverse pass voids any it had booked), so
  // R5 must not enumerate — nor flag — its otherwise-live children.
  it("S_STMT_VOID_INVOICE: children of a voided owner_statement Invoice are not flagged missing", async () => {
    await seedFrozenPeriodWithPaidRent();
    await makeStatement({
      invoiceId: INV_STMT,
      status: "void",
      charges: [{ id: C_STMT_MGMT, chargeType: "management_fee", amount: "108.00", number: "S2L-VOIDINV-MGMT" }],
    });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STMT_MGMT)).toHaveLength(0); // void invoice → not a source → no finding
  });

  // ── S_STMT_R6_DEFERRAL: a statement row that WAS booked at freeze (captured in the ─────
  // write-once manifest) but is voided/deleted AFTER freeze is R6 (frozen-integrity)'s domain,
  // not R5's. R5 must stay SILENT so the post-freeze deletion is not double-flagged (exactly as
  // the income path defers a manifest-present source). R5's own job is the NEVER-booked case.
  it("S_STMT_R6_DEFERRAL: a statement row booked at freeze then voided post-freeze is NOT flagged by R5 (R6's domain)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_SEED, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-DEFER-RENT" });
    await payCharge({ chargeId: C_SEED, amount: "800.00", createdAt: frozenDue });
    await makeStatement({
      invoiceId: INV_STMT,
      sstAmount: "6.48",
      charges: [{ id: C_STMT_MGMT, chargeType: "management_fee", amount: "108.00", number: "S2L-DEFER-MGMT" }],
    });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // books the mgmt statement row
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M }); // manifest captures it
    // Post-freeze deletion (voided live row) — the exact corruption R6 owns.
    const stmtRow = await db.ownerLedgerEntry.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "statement", sourceChargeId: C_STMT_MGMT } });
    await db.ownerLedgerEntry.update({ where: { id: stmtRow.id }, data: { status: "void" } });

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STMT_MGMT)).toHaveLength(0); // in manifest → R5 defers to R6 (no double-flag)
  });

  // ── S_STMT_WRONG_AMOUNT: a statement row that physically EXISTS but with the wrong amount ─
  // in cents (108.00 charge booked as 99.00), never captured at freeze (not in manifest), is a
  // mis-booked expense the owner is under/over-charged for. R5 asserts the row matches category
  // + amount in cents, so the correctly-shaped expected row is MISSING → critical finding.
  it("S_STMT_WRONG_AMOUNT: a statement row booked with the wrong amount (not in manifest) opens missing_ledger_row", async () => {
    const db = getDb();
    await seedFrozenPeriodWithPaidRent();
    await makeStatement({
      invoiceId: INV_STMT,
      charges: [{ id: C_STMT_MGMT, chargeType: "management_fee", amount: "108.00", number: "S2L-WRONG-MGMT" }],
    });
    // A live statement row for the charge, but 99.00 instead of the charge's 108.00 (post-freeze → not in manifest).
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: frozenStart, transactionDate: frozenStart, direction: "expense", category: "management_fee", amount: "99.00", paidBy: "kaen", paymentStatus: "pending", includeInPayout: true, sourceType: "statement", sourceChargeId: C_STMT_MGMT, sourceInvoiceId: INV_STMT, status: "active", createdById: USER, updatedById: USER },
    });

    await runSourceToLedger(ledgerCtx, {});
    const f = await findingsFor(C_STMT_MGMT);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("missing_ledger_row");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(10800); // the charge's true amount
    expect(f[0]!.actualAmountC).toBe(9900); // the mis-booked live row
  });

  // ── S_STMT_ADJ (seam #1 — payout netting): an ACTIVE charge-backed CN on a statement ─────
  // charge must net into BOTH the sync's booked row AND R5's own expected-row re-derivation
  // (expectedStatementLedgerRows via the SAME netAdjustmentsByChargeId helper) — else the two
  // would diverge and R5 would false-flag every adjusted charge as missing_ledger_row. Proves
  // recon stays clean (discrepancyC === 0, i.e. no finding) AND that the statement-expense
  // component the sync booked reflects the netted 70 (100 − active CN 30), not the raw 100.
  it("S_STMT_ADJ: an active charge-adjustment CN nets into the booked statement row and R5 stays clean (no false-flag)", async () => {
    const db = getDb();
    await makeRentCharge({ id: C_SEED, status: "paid", amount: "800.00", outstanding: "0.00", number: "S2L-ADJ-RENT" });
    await payCharge({ chargeId: C_SEED, amount: "800.00", createdAt: frozenDue });
    await makeStatement({
      invoiceId: INV_STMT,
      charges: [{ id: C_STMT_ADJ, chargeType: "management_fee", amount: "100.00", number: "S2L-ADJ-MGMT" }],
    });
    await db.documentSeries.create({ data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true } });
    // Mint the ACTIVE CN BEFORE the sync so the sync's own netAdjustmentsByChargeId call nets
    // it into the row it books (mirrors the real create → post-commit re-sync ordering).
    await mintChargeCreditNote({ id: CN_DOC_ADJ, chargeId: C_STMT_ADJ, amount: "30.00", number: "S2L-ADJ-CN" });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M }); // books mgmt_fee netted to 70
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    const row = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: C_STMT_ADJ },
      select: { amount: true },
    });
    expect(Number(row.amount.toString())).toBe(70); // statement-expense component reflects the netted 70, not 100

    await runSourceToLedger(ledgerCtx, {});
    expect(await findingsFor(C_STMT_ADJ)).toHaveLength(0); // R5 re-derives the SAME netted 70 → discrepancyC === 0, no finding
  });
});
