/**
 * R4 — prior-period-adjustment (PPA) backend SPIKE (integration, RUN_INTEGRATION=1).
 *
 * An admin records a newly-discovered prior-period CHARGE dated into an already-
 * FROZEN owner-statement month WITHOUT corrupting the frozen statement: the source
 * Charge keeps its true frozen `billingMonth`, but its owner-ledger effect posts as a
 * `prior_period_adjustment` OwnerLedgerEntry into the CURRENT OPEN `statementMonth`.
 * NO normal frozen-month ledger row is created; direction is NOT flipped; one atomic
 * $transaction; idempotent (one PPA per source charge). Distinct from
 * `prior_period_collection` (new CASH on an existing frozen charge) — PPA is a new charge.
 *
 * Flag-dark: the whole feature is gated on ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT (default
 * OFF). Frozen month = the calendar month BEFORE now; current open month = now's month
 * (derived at runtime so the suite is date-independent).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT=1 \
 *     npx vitest run \
 *     src/modules/owner-ledger/__tests__/prior-period-adjustment.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { createPriorPeriodAdjustment } from "../prior-period-adjustment";
import { assertPeriodOpen } from "../assert-period-open";
import { ClosedPeriodError } from "../closed-period";
import { syncMonthService } from "../owner-ledger.sync";
import { runSourceToLedger } from "../reconciliation/source-to-ledger";
import { freezeStatementPeriod } from "../../owner-billing/owner-statement-period.service";
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

// ── Fixed disjoint UUIDs (prefix 9cd2; unused by any other suite) ───────────────
const ORG = "9cd20000-0000-4000-8000-000000000001";
const USER = "9cd20000-0000-4000-8000-000000000002";
const OWNER = "9cd20000-0000-4000-8000-000000000003";
const OTHER_OWNER = "9cd20000-0000-4000-8000-00000000000e";
const TENANT = "9cd20000-0000-4000-8000-000000000004";
const PROP = "9cd20000-0000-4000-8000-000000000005";
const APT = "9cd20000-0000-4000-8000-000000000006";
const UNIT = "9cd20000-0000-4000-8000-000000000007";
const TEN = "9cd20000-0000-4000-8000-000000000008";
const C_SEED = "9cd20000-0000-4000-8000-000000000009"; // a pre-existing (pre-freeze) charge

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ── Runtime-derived months (date-independent) ──────────────────────────────────
const NOW = new Date();
const curStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const ym = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const FROZEN_M = ym(frozenStart);
const CUR_M = ym(curStart);
const frozenDueStr = `${FROZEN_M}-05`;

let savedBilling: string | undefined;
let savedPpa: string | undefined;

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
  await db.ownerLedgerReconciliationRun.deleteMany({ where: org });
  await db.paymentAllocationReversal.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
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
      id: ORG, name: "9CD2 PPA Org", slug: "9cd2-ppa-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "9cd2@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "9CD2 Admin" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "PPA Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OTHER_OWNER, organizationId: ORG, displayName: "PPA Other Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "PPA Tenant", partyType: "individual", status: "active" } });
  await db.property.create({
    data: { id: PROP, organizationId: ORG, name: "PPA Tower", propertyCode: "PPA-P1", propertyType: "apartment", addressLine1: "1 PPA St", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "PPA-01-01", listingMode: "WHOLE" } });
  await db.listing.create({
    data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER },
  });
  await db.tenancy.create({
    data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: UNIT, tenantPartyId: TENANT, tenancyCode: "PPA-T1", status: "active", billingStatus: "current", startDate: new Date(Date.UTC(2025, 0, 1)), monthlyRentAmount: "800" },
  });
}

/** Freeze the frozen month for OWNER (combined scope). Empty unless a pre-existing charge was synced. */
async function freezeFrozenMonth() {
  return freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
}

/** Standard create-mode PPA input for a fully-collected rent charge discovered in the frozen month. */
function ppaInput(over: Partial<Parameters<typeof createPriorPeriodAdjustment>[1]> = {}) {
  return {
    ownerPartyId: OWNER,
    originalBillingMonth: FROZEN_M,
    sourceChargeInput: {
      unitId: UNIT,
      partyId: TENANT,
      chargeType: "rent",
      amount: "800.00",
      outstandingAmount: "0.00",
      status: "paid",
      tenancyId: TEN,
      dueDate: frozenDueStr,
      chargeNumber: `PPA-RENT-${Math.random().toString(36).slice(2, 8)}`,
    },
    ...over,
  };
}

const ppaRows = () =>
  getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "prior_period_adjustment" } });

dn("createPriorPeriodAdjustment — flag-dark spike (R4, integration)", () => {
  beforeAll(() => {
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedPpa = process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = "1";
  });
  afterAll(async () => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedPpa === undefined) delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    else process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = savedPpa;
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  // ── B1: create-mode atomic create ─────────────────────────────────────────────
  it("B1: flag ON + frozen original month → creates a Charge (billingMonth=frozen) AND a prior_period_adjustment ledger entry in the current OPEN month", async () => {
    const db = getDb();
    await freezeFrozenMonth();

    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.status).toBe(201);

    // The source Charge keeps its TRUE frozen billingMonth.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: res.data.charge.id } });
    expect(charge.billingMonth?.getTime()).toBe(frozenStart.getTime());
    expect(charge.organizationId).toBe(ORG);

    // Exactly one prior_period_adjustment ledger entry, in the OPEN month, linked to the charge.
    const ppas = await ppaRows();
    expect(ppas).toHaveLength(1);
    const ppa = ppas[0]!;
    expect(ppa.sourceChargeId).toBe(charge.id);
    expect(ppa.statementMonth.getTime()).toBe(curStart.getTime());
    expect(ppa.direction).toBe("income"); // income charge → income row (NOT flipped)
    expect(Number(ppa.amount.toString())).toBe(800); // collected = amount − outstanding
    expect(ppa.ownerPartyId).toBe(OWNER);
    expect(ppa.status).toBe("active");
  });

  // ── B6: flag OFF → 404, nothing written ───────────────────────────────────────
  it("B6: PPA flag OFF → 404 and writes nothing (no charge, no PPA ledger row)", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const prev = process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
    try {
      const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.status).toBe(404);
      expect(await ppaRows()).toHaveLength(0);
      expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT;
      else process.env.ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT = prev;
    }
  });

  // ── B10: original month NOT frozen → 400, nothing written ──────────────────────
  it("B10: original month NOT frozen (no frozen period) → 400 and writes nothing", async () => {
    const db = getDb();
    // Deliberately do NOT freeze → the owner's original-month period is absent/open.
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(400);
    expect(await ppaRows()).toHaveLength(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── B13: targetPostingMonth ≠ current open month → 400 (blocks frozen posting month) ─
  it("B13: targetPostingMonth other than the current open month (here the frozen month) → 400 and writes nothing", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput({ targetPostingMonth: FROZEN_M }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(400);
    expect(await ppaRows()).toHaveLength(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── B15: a non-income source charge type is unsupported by the spike → 400 ─────
  it("B15: a non-income source charge type (management_fee) → 400 and writes nothing (spike books income only)", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const base = ppaInput();
    const res = await createPriorPeriodAdjustment(ledgerCtx, {
      ...base,
      sourceChargeInput: { ...base.sourceChargeInput!, chargeType: "management_fee" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(400);
    expect(await ppaRows()).toHaveLength(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── B11: create-mode unit owned by a DIFFERENT owner → 403, nothing written ────
  it("B11: create-mode unit owned by a different owner than ownerPartyId → 403 and writes nothing", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    // UNIT is owned by OWNER; request claims OTHER_OWNER → owner/unit mismatch.
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput({ ownerPartyId: OTHER_OWNER }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(403);
    expect(await ppaRows()).toHaveLength(0);
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── B9: ref-mode idempotency (one PPA per source charge) ──────────────────────
  it("B9: ref-mode on an existing frozen income charge posts one PPA; a second call is idempotent (still one PPA, no new charge)", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    await db.charge.create({
      data: { id: C_SEED, organizationId: ORG, chargeNumber: "PPA-REF-1", partyId: TENANT, tenancyId: TEN, unitId: UNIT, chargeType: "rent", status: "paid", postedAt: new Date(), dueDate: new Date(frozenDueStr), amount: "500.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: frozenStart },
    });
    const refInput = { ownerPartyId: OWNER, originalBillingMonth: FROZEN_M, sourceChargeId: C_SEED };

    const r1 = await createPriorPeriodAdjustment(ledgerCtx, refInput);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("unreachable");
    expect(r1.data.idempotentReplay).toBe(false);

    const r2 = await createPriorPeriodAdjustment(ledgerCtx, refInput);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("unreachable");
    expect(r2.data.idempotentReplay).toBe(true);

    const ppas = await ppaRows();
    expect(ppas).toHaveLength(1);
    expect(ppas[0]!.sourceChargeId).toBe(C_SEED);
    expect(Number(ppas[0]!.amount.toString())).toBe(500); // collected = amount − outstanding
    expect(await db.charge.count({ where: { organizationId: ORG } })).toBe(1); // ref-mode created NO new charge
  });

  // ── B16: ref-mode source charge not in this org → 404 (org-scoped lookup) ──────
  it("B16: ref-mode with a sourceChargeId not in this org → 404 and writes nothing", async () => {
    await freezeFrozenMonth();
    const res = await createPriorPeriodAdjustment(ledgerCtx, {
      ownerPartyId: OWNER, originalBillingMonth: FROZEN_M, sourceChargeId: "9cd20000-0000-4000-8000-0000000000fe",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(404);
    expect(await ppaRows()).toHaveLength(0);
  });

  // ── B14: concurrent ref-mode calls → exactly one PPA (P2002-safe) ─────────────
  it("B14: two concurrent ref-mode calls on the same charge post exactly one PPA and both resolve ok", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    await db.charge.create({
      data: { id: C_SEED, organizationId: ORG, chargeNumber: "PPA-REF-CC", partyId: TENANT, tenancyId: TEN, unitId: UNIT, chargeType: "rent", status: "paid", postedAt: new Date(), dueDate: new Date(frozenDueStr), amount: "500.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: frozenStart },
    });
    const refInput = { ownerPartyId: OWNER, originalBillingMonth: FROZEN_M, sourceChargeId: C_SEED };
    const [a, b] = await Promise.all([
      createPriorPeriodAdjustment(ledgerCtx, refInput),
      createPriorPeriodAdjustment(ledgerCtx, refInput),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await ppaRows()).toHaveLength(1); // never duplicated
  });

  // ── B4: atomic — a forced ledger-insert failure rolls back the source Charge ───
  it("B4: a ledger-insert collision (with a prior VOID PPA) rolls back the source Charge — both or neither, 409", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const KNOWN = "9cd20000-0000-4000-8000-0000000000a4";
    // A prior PPA for KNOWN exists but is VOID: the active-scoped idempotency pre-check
    // misses it, so the ledger insert collides on the (org,sourceType,sourceChargeId)
    // partial unique and throws IN the tx.
    await db.ownerLedgerEntry.create({
      data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: PROP, apartmentId: APT, listingId: UNIT, statementMonth: curStart, transactionDate: curStart, direction: "income", category: "rental_income", amount: "800.00", paidBy: "kaen", paymentStatus: "paid", includeInPayout: true, sourceType: "prior_period_adjustment", sourceChargeId: KNOWN, status: "void", createdById: USER, updatedById: USER },
    });
    const base = ppaInput();
    const res = await createPriorPeriodAdjustment(ledgerCtx, {
      ...base,
      sourceChargeInput: { ...base.sourceChargeInput!, id: KNOWN },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.status).toBe(409);
    // The source Charge (id=KNOWN) was rolled back — no orphan frozen-dated charge.
    expect(await db.charge.findUnique({ where: { id: KNOWN } })).toBeNull();
    // Still exactly one PPA row (the pre-existing void) — no duplicate created.
    expect(await ppaRows()).toHaveLength(1);
  });

  // ── B2: no normal frozen-month row; no charge-sync fan-out (exactly one PPA row) ─
  it("B2: creates NO normal frozen-month ledger row — exactly one ledger row (the PPA) for the charge, none in the frozen month", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    if (!res.ok) throw new Error("unreachable");
    const chargeId = res.data.charge.id;
    const all = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceChargeId: chargeId } });
    expect(all).toHaveLength(1); // no rent/normal twin — raw tx.charge.create never fires the sync hook
    expect(all[0]!.sourceType).toBe("prior_period_adjustment");
    expect(all[0]!.statementMonth.getTime()).toBe(curStart.getTime());
    const frozenRows = await db.ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceChargeId: chargeId, statementMonth: frozenStart } });
    expect(frozenRows).toHaveLength(0);
  });

  // ── B3: attributes preserved (no flip, no reversal) ───────────────────────────
  it("B3: preserves the charge's NATURAL effect — income (not flipped), rental_income, includeInPayout, paidBy, paymentStatus, owner", async () => {
    await freezeFrozenMonth();
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    if (!res.ok) throw new Error("unreachable");
    const ppa = res.data.ledgerEntry;
    expect(ppa.direction).toBe("income"); // NOT flipped to expense
    expect(ppa.category).toBe("rental_income");
    expect(ppa.includeInPayout).toBe(true);
    expect(ppa.paidBy).toBe("kaen");
    expect(ppa.paymentStatus).toBe("paid"); // charge status "paid"
    expect(ppa.ownerPartyId).toBe(OWNER);
    expect(ppa.sstAmount).toBeNull();
  });

  // ── B12: partial-paid source → COLLECTED amount (amount − outstanding), cents-exact ─
  it("B12: a partially-collected source charge posts the COLLECTED amount (amount − outstanding), cents-exact", async () => {
    await freezeFrozenMonth();
    const base = ppaInput();
    const res = await createPriorPeriodAdjustment(ledgerCtx, {
      ...base,
      sourceChargeInput: { ...base.sourceChargeInput!, amount: "1000.00", outstandingAmount: "700.00", status: "partially_paid" },
    });
    if (!res.ok) throw new Error("unreachable");
    const ppa = res.data.ledgerEntry;
    expect(Math.round(Number(ppa.amount.toString()) * 100)).toBe(30000); // collected 300.00, cents-exact
    expect(ppa.paymentStatus).toBe("partial");
  });

  // ── B5: the frozen snapshot / manifest / closing balance are NEVER touched ─────
  it("B5: a PPA never touches the frozen period's snapshot, manifest rows, or closing balance", async () => {
    const db = getDb();
    // A pre-existing PAID rent charge in the frozen month → non-empty snapshot + manifest.
    await db.charge.create({
      data: { id: C_SEED, organizationId: ORG, chargeNumber: "PPA-SEED", partyId: TENANT, tenancyId: TEN, unitId: UNIT, chargeType: "rent", status: "paid", postedAt: new Date(), dueDate: new Date(frozenDueStr), amount: "800.00", currency: "MYR", outstandingAmount: "0.00", billingMonth: frozenStart },
    });
    await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });
    const frozen = await freezeFrozenMonth();
    const beforeSnap = JSON.stringify(frozen.snapshotJson);
    const beforeClosing = frozen.closingBalanceC;
    const manifestBefore = await db.ownerStatementFreezeManifestRow.findMany({ where: { organizationId: ORG, ownerStatementPeriodId: frozen.id }, orderBy: { amountC: "asc" } });
    expect(manifestBefore.length).toBeGreaterThan(0);

    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    expect(res.ok).toBe(true);

    const periodAfter = await db.ownerStatementPeriod.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(JSON.stringify(periodAfter.snapshotJson)).toBe(beforeSnap);
    expect(periodAfter.closingBalanceC).toBe(beforeClosing);
    const manifestAfter = await db.ownerStatementFreezeManifestRow.findMany({ where: { organizationId: ORG, ownerStatementPeriodId: frozen.id }, orderBy: { amountC: "asc" } });
    expect(JSON.stringify(manifestAfter)).toBe(JSON.stringify(manifestBefore));
  });

  // ── B7: the PPA is recognized as VALID by R5 reconciliation ───────────────────
  it("B7: runSourceToLedger recognizes the PPA as VALID (no invalid_forward_adjustment / missing_ledger_row for its charge)", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const res = await createPriorPeriodAdjustment(ledgerCtx, ppaInput());
    if (!res.ok) throw new Error("unreachable");
    const chargeId = res.data.charge.id;

    await runSourceToLedger(ledgerCtx, { ownerPartyId: OWNER, month: FROZEN_M });

    const findings = await db.ownerLedgerReconciliationFinding.findMany({ where: { organizationId: ORG, sourceId: chargeId } });
    const bad = findings.filter((f) => f.findingType === "invalid_forward_adjustment" || f.findingType === "missing_ledger_row");
    expect(bad).toHaveLength(0);
  });

  // ── B8: intent is the ONLY frozen-write bypass (general path blocked) ──────────
  it("B8: with LIVE_LEDGER on, a no-intent write to the frozen period throws; the PPA intent resolves (general paths never pass the intent — see closed-period-guard B18)", async () => {
    const db = getDb();
    await freezeFrozenMonth();
    const savedLL = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
    try {
      await db.$transaction(async (tx) => {
        await expect(assertPeriodOpen(tx, ORG, OWNER, frozenStart)).rejects.toBeInstanceOf(ClosedPeriodError);
        await expect(
          assertPeriodOpen(tx, ORG, OWNER, frozenStart, { intent: "prior_period_adjustment" }),
        ).resolves.toBeUndefined();
      });
    } finally {
      if (savedLL === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
      else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLL;
    }
  });
});
