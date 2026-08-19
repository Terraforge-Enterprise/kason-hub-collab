/**
 * Task 2 — closed-period write guard, end-to-end (integration, RUN_INTEGRATION=1).
 * MONEY: proves the shared assertPeriodOpen guard rejects owner-impacting writes
 * dated into a FROZEN owner-statement month, before the money tx commits, while
 * leaving open months + payment/void paths byte-identical.
 *
 * Run:
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     npx vitest run src/modules/owner-ledger/__tests__/closed-period-guard.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { closedPeriodErrorBody } from "@kason/shared";
import { createEntryService } from "../owner-ledger.service";
import {
  addStatementLineService,
  updateStatementLineService,
  voidStatementLineService,
  generateStatementService,
} from "../../owner-billing/owner-billing.service";
import { ClosedPeriodError } from "../closed-period";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const LEDGER = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// Fixed disjoint UUIDs (prefix c105 — unused by any other suite).
const ORG = "c1050000-0000-4000-8000-000000000001";
const USER = "c1050000-0000-4000-8000-000000000002";
const OWNER_A = "c1050000-0000-4000-8000-000000000003";
const OWNER_B = "c1050000-0000-4000-8000-000000000004";
const PROP = "c1050000-0000-4000-8000-000000000005";
const APT = "c1050000-0000-4000-8000-000000000006";

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// Fixed FROZEN month (deterministic, in the past) + an OPEN month with no period row.
const FROZEN_M = "2026-03";
const frozenStart = new Date(Date.UTC(2026, 2, 1));
const OPEN_M = "2026-05";

function entryInput(over: Record<string, unknown> = {}) {
  return {
    ownerPartyId: OWNER_A,
    propertyId: PROP,
    listingId: null,
    tenancyId: null,
    statementMonth: FROZEN_M,
    transactionDate: `${FROZEN_M}-15`,
    direction: "income" as const,
    category: "rental_income" as const,
    description: null,
    remarks: null,
    amount: "1200.00",
    sstAmount: null,
    paidBy: "kaen" as const,
    paymentStatus: "paid" as const,
    taxCategory: "check_with_tax_agent" as const,
    attachmentKeys: [],
    ...over,
  };
}

async function seedFrozenPeriod(ownerPartyId: string, periodMonth: Date) {
  await getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId,
      apartmentId: null,
      periodMonth,
      status: "frozen",
      idempotencyKey: `ownerstmt:${ownerPartyId}:${periodMonth.toISOString().slice(0, 7)}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

/** Create a DRAFT owner_statement Invoice (+ optional child charge) directly. */
async function seedDraftStatement(id: string, periodMonth: Date, chargeId?: string) {
  const db = getDb();
  const ym = `${periodMonth.getUTCFullYear()}${String(periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  await db.invoice.create({
    data: {
      id,
      organizationId: ORG,
      invoiceNumber: `OS-${ym}-${id.slice(0, 8)}`,
      partyId: OWNER_A,
      ownerPartyId: OWNER_A,
      invoiceType: "owner_statement",
      status: "draft",
      invoiceDate: new Date(),
      periodMonth,
      totalAmount: "0.00",
      currency: "MYR",
    },
  });
  if (chargeId) {
    await db.charge.create({
      data: {
        id: chargeId,
        organizationId: ORG,
        chargeNumber: `OSC-${ym}-${chargeId.slice(0, 8)}-0001`,
        partyId: OWNER_A,
        chargeType: "maintenance",
        status: "draft",
        dueDate: periodMonth,
        billingMonth: periodMonth,
        amount: "100.00",
        outstandingAmount: "100.00",
        currency: "MYR",
        invoiceId: id,
        attachmentKeys: [],
      },
    });
  }
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.auditLog.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "C105 Closed-Period Org", slug: "c105-closed-period-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "c105@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "C105 Admin" },
  });
  await db.party.create({ data: { id: OWNER_A, organizationId: ORG, displayName: "Owner A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_B, organizationId: ORG, displayName: "Owner B", partyType: "individual", status: "active" } });
  // findOwnerInOrg (generate path) requires an "owner" PartyRole.
  await db.partyRole.create({ data: { organizationId: ORG, partyId: OWNER_A, roleType: "owner", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "C105 Tower", propertyCode: "C105-P1", propertyType: "apartment", addressLine1: "1 C105 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "C105-01-01", listingMode: "WHOLE" } });
}

async function setFlag(on: boolean) {
  if (on) process.env[LEDGER] = "1";
  else delete process.env[LEDGER];
}

dn("closed-period write guard — end-to-end (integration)", () => {
  let savedLedger: string | undefined;
  let savedBilling: string | undefined;
  let savedPpa: string | undefined;
  beforeAll(() => {
    savedLedger = process.env[LEDGER];
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    // B12/B18 assert the flag-OFF closed_period body (priorPeriodAdjustmentSupported:false,
    // suggestedPostingMonth:null), so pin the PPA flag OFF regardless of the ambient env
    // (a whole-module run may set ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT=1).
    savedPpa = process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });
  afterAll(async () => {
    if (savedLedger === undefined) delete process.env[LEDGER];
    else process.env[LEDGER] = savedLedger;
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedPpa === undefined) delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    else process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = savedPpa;
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await setFlag(true); // default flag ON; flag-off tests override + restore
  });

  // ── createEntryService (manual owner-ledger entry) ─────────────────────────
  it("B10: open month (no frozen period) + flag ON → createEntryService succeeds (201)", async () => {
    const res = await createEntryService(ledgerCtx, entryInput({ statementMonth: OPEN_M, transactionDate: `${OPEN_M}-15` }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
  });

  it("B11: flag OFF into a frozen month → createEntryService succeeds (byte-identical)", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    await setFlag(false);
    try {
      const res = await createEntryService(ledgerCtx, entryInput());
      expect(res.ok).toBe(true);
      expect(res.status).toBe(201);
    } finally {
      await setFlag(true);
    }
  });

  it("B12: frozen month + flag ON → 409 closed_period body; NO ledger row + NO audit row persisted", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const db = getDb();
    const res = await createEntryService(ledgerCtx, entryInput());
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    if (res.ok) return;
    // structured body parity + schema validity
    expect(res.body).toBeDefined();
    expect(closedPeriodErrorBody.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      code: "closed_period",
      originalBillingMonth: FROZEN_M,
      priorPeriodAdjustmentSupported: false,
      suggestedPostingMonth: null,
    });
    // no orphan: no ledger row, no audit row for the rejected write
    const rows = await db.ownerLedgerEntry.count({ where: { organizationId: ORG, ownerPartyId: OWNER_A } });
    expect(rows).toBe(0);
    const audits = await db.auditLog.count({ where: { organizationId: ORG, entityType: "OwnerLedgerEntry" } });
    expect(audits).toBe(0);
  });

  it("B18: a stray body intent=prior_period_adjustment does NOT bypass the guard (no leak)", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const res = await createEntryService(ledgerCtx, entryInput({ intent: "prior_period_adjustment" }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it("B20: per-owner isolation — owner A's frozen month does NOT block owner B's write", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const res = await createEntryService(ledgerCtx, entryInput({ ownerPartyId: OWNER_B }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
  });

  it("B21: keyed on statementMonth, NOT transactionDate (frozen statementMonth + open txn date → 409)", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const res = await createEntryService(ledgerCtx, entryInput({ statementMonth: FROZEN_M, transactionDate: `${OPEN_M}-10` }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it("B22: apartment-scoped write is judged against the COMBINED frozen period → 409", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const res = await createEntryService(ledgerCtx, entryInput({ apartmentId: APT }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  // ── statement add-line (charge-backed create via insertStatementChargeAndRecompute) ──
  it("B13: addStatementLineService into a frozen month + flag ON → throws; NO charge persisted", async () => {
    const INV = "c1050000-0000-4000-8000-0000000000a1";
    await seedFrozenPeriod(OWNER_A, frozenStart);
    await seedDraftStatement(INV, frozenStart);
    const db = getDb();
    await expect(
      addStatementLineService(billingCtx, INV, { chargeType: "maintenance", description: "x", amount: "50.00" }),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
    const charges = await db.charge.count({ where: { organizationId: ORG, invoiceId: INV } });
    expect(charges).toBe(0);
  });

  it("B14: addStatementLineService into an OPEN month → line added (201-equivalent ok)", async () => {
    const INV = "c1050000-0000-4000-8000-0000000000a2";
    await seedDraftStatement(INV, new Date(Date.UTC(2026, 4, 1)));
    const res = await addStatementLineService(billingCtx, INV, { chargeType: "maintenance", description: "x", amount: "50.00" });
    expect(res.ok).toBe(true);
    const charges = await getDb().charge.count({ where: { organizationId: ORG, invoiceId: INV } });
    expect(charges).toBe(1);
  });

  it("B25: flag OFF — addStatementLineService into a frozen month still adds the line (byte-identical)", async () => {
    const INV = "c1050000-0000-4000-8000-0000000000a3";
    await seedFrozenPeriod(OWNER_A, frozenStart);
    await seedDraftStatement(INV, frozenStart);
    await setFlag(false);
    try {
      const res = await addStatementLineService(billingCtx, INV, { chargeType: "maintenance", description: "x", amount: "50.00" });
      expect(res.ok).toBe(true);
    } finally {
      await setFlag(true);
    }
  });

  // ── economic edit vs void on an existing frozen-month line ─────────────────
  it("B24: economic edit of a frozen-month statement line throws; voiding the same line is ALLOWED", async () => {
    const INV = "c1050000-0000-4000-8000-0000000000b1";
    const CHG = "c1050000-0000-4000-8000-0000000000b2";
    await seedFrozenPeriod(OWNER_A, frozenStart);
    await seedDraftStatement(INV, frozenStart, CHG);
    // economic edit (amount change) → blocked
    await expect(
      updateStatementLineService(billingCtx, INV, CHG, { amount: "999.00", expectedUpdatedAt: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
    // void of the SAME existing line → NOT blocked
    const voided = await voidStatementLineService(billingCtx, INV, CHG);
    expect(voided.ok).toBe(true);
  });

  // ── statement generate (createStatementCharge path) ────────────────────────
  it("B15: generateStatementService for a frozen owner-month + flag ON → throws; no Invoice created", async () => {
    await seedFrozenPeriod(OWNER_A, frozenStart);
    const db = getDb();
    await expect(
      generateStatementService(billingCtx, { ownerPartyId: OWNER_A, billingMonth: FROZEN_M }),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
    const invs = await db.invoice.count({ where: { organizationId: ORG, invoiceType: "owner_statement", periodMonth: frozenStart } });
    expect(invs).toBe(0);
  });
});
