/**
 * frozen-integrity.integration.test.ts — R6 Reconciliation Check #2.
 *
 * Ledger-first integrity: for each frozen period WITH a write-once manifest, diff the
 * LIVE OwnerLedgerEntry rows against the immutable manifest baseline (R7) and the
 * persisted firstFrozen* balances, flagging every post-freeze mutation of a closed
 * month — creations (post_freeze_creation), economic edits / field mismatches, voided
 * or unexplained frozen-month rows, and balance drift. Catches Family 2 (manual entry),
 * which R5 structurally cannot. READ-ONLY w.r.t. money. Runs INDEPENDENT of
 * ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (spec R10).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/frozen-integrity.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { freezeStatementPeriod } from "../../../owner-billing/owner-statement-period.service";
import { runFrozenIntegrity } from "../frozen-integrity";
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

// ── Fixed disjoint UUIDs (prefix 6f10; unused by any other suite) ───────────────
const ORG = "6f100000-0000-4000-8000-000000000001";
const USER = "6f100000-0000-4000-8000-000000000002";
const OWNER = "6f100000-0000-4000-8000-000000000003";
const PROP = "6f100000-0000-4000-8000-000000000005";
const APT = "6f100000-0000-4000-8000-000000000006";
const UNIT = "6f100000-0000-4000-8000-000000000007";

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

const NOW = new Date();
const curStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const frozenStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const ym = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const FROZEN_M = ym(frozenStart);
const dayInFrozen = (d: number): Date => new Date(Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), d));

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: org });
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function insertEntry(o: {
  id?: string;
  statementMonth?: Date;
  transactionDate?: Date;
  direction?: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
  includeInPayout?: boolean;
  paidBy?: string;
  category?: string;
  sstAmount?: string | null;
  sourceType?: string;
  createdAt?: Date;
}) {
  const row = await getDb().ownerLedgerEntry.create({
    data: {
      ...(o.id ? { id: o.id } : {}),
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROP,
      apartmentId: APT,
      listingId: UNIT,
      statementMonth: o.statementMonth ?? frozenStart,
      transactionDate: o.transactionDate ?? dayInFrozen(5),
      direction: o.direction ?? "income",
      category: o.category ?? (o.direction === "expense" ? "management_fee" : "rental_income"),
      amount: o.amount,
      sstAmount: o.sstAmount ?? null,
      paidBy: o.paidBy ?? "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      includeInPayout: o.includeInPayout ?? (o.direction === "expense"),
      attachmentKeys: [],
      sourceType: o.sourceType ?? "manual",
      status: o.status ?? "active",
      createdById: USER,
      updatedById: USER,
    },
  });
  // createdAt is a default(now()) column — override explicitly when a test needs a
  // pre/post-freeze timestamp for the createdAt > firstFrozenAt discriminator.
  if (o.createdAt) {
    await getDb().ownerLedgerEntry.update({ where: { id: row.id }, data: { createdAt: o.createdAt } });
  }
  return row;
}

const findings = () =>
  getDb().ownerLedgerReconciliationFinding.findMany({ where: { organizationId: ORG, checkKind: "frozen_integrity" } });
const findingsForSource = (sourceId: string) =>
  getDb().ownerLedgerReconciliationFinding.findMany({ where: { organizationId: ORG, checkKind: "frozen_integrity", sourceId } });

async function freezeWith(rows: Array<Parameters<typeof insertEntry>[0]>) {
  for (const r of rows) await insertEntry(r);
  return freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
}

dn("runFrozenIntegrity — frozen-snapshot-to-live integrity (R6, integration)", () => {
  let savedLedger: string | undefined;
  beforeAll(async () => {
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER; // prove flag-independence
    await cleanup();
    const db = getDb();
    await db.organization.create({ data: { id: ORG, name: "6F10 Frozen Integrity Org", slug: "6f10-frozen-integrity-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
    await db.user.create({ data: { id: USER, organizationId: ORG, email: "6f10@test.local", passwordHash: "x", role: "admin", status: "active", fullName: "6F10 Admin" } });
    await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "FI Owner", partyType: "individual", status: "active" } });
    await db.property.create({ data: { id: PROP, organizationId: ORG, name: "FI Tower", propertyCode: "FI-P1", propertyType: "apartment", addressLine1: "1 FI St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
    await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "FI-01-01", listingMode: "WHOLE" } });
    await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APT, listingType: "Whole Unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  });
  afterAll(async () => {
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    const db = getDb();
    await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
    await db.ownerStatementFreezeManifestRow.deleteMany({ where: { organizationId: ORG } });
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  });

  // ── I1: a manual row created INTO the frozen month after firstFrozenAt ───────────
  it("I1: a manual OwnerLedgerEntry created into the frozen month after firstFrozenAt opens a critical post_freeze_creation", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    expect(process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER).toBeUndefined(); // flag-independent

    // Family 2 breach: a manual entry written straight into the frozen statementMonth.
    const injected = await insertEntry({
      amount: "999.00", direction: "income", statementMonth: frozenStart,
      createdAt: new Date(firstFrozenAt.getTime() + 60_000),
    });

    await runFrozenIntegrity(ledgerCtx, {});

    const f = await findingsForSource(injected.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("post_freeze_creation");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.status).toBe("open");
    expect(f[0]!.sourceType).toBe("owner_ledger_entry");
    expect(f[0]!.originalBillingMonth!.getTime()).toBe(frozenStart.getTime());
  });

  // ── I2: a legitimately-unpaid row present at freeze is IN the manifest → no finding ─
  it("I2: an unpaid-active row present at freeze produces no finding (it is captured in the manifest)", async () => {
    await freezeWith([
      { amount: "1500.00", direction: "income", paymentStatus: "paid" },
      { amount: "100.00", direction: "income", paymentStatus: "unpaid" },
    ]);
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await findings()).toHaveLength(0);
  });

  // ── I5: an authorised forward row lives in the OPEN month → no false positive ─────
  it("I5: a prior_period_collection in the open month is not flagged as a frozen-month row", async () => {
    await freezeWith([{ amount: "1500.00", direction: "income" }]);
    await insertEntry({ amount: "800.00", direction: "income", statementMonth: curStart, sourceType: "prior_period_collection", createdAt: new Date() });
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await findings()).toHaveLength(0);
  });

  // ── I6: a frozen period with no manifest (firstFrozenAt null) is skipped ──────────
  it("I6: a frozen period lacking a manifest (firstFrozenAt null) is skipped (integrity unknown)", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    await getDb().ownerStatementPeriod.update({ where: { id: frozen.id }, data: { firstFrozenAt: null } });
    await insertEntry({ amount: "999.00", direction: "income", statementMonth: frozenStart }); // would-be breach
    await runFrozenIntegrity(ledgerCtx, {});
    expect(await findings()).toHaveLength(0); // no baseline to diff → skipped, not flagged
  });

  // ── I_UNEXPLAINED: a backdated createdAt row absent from the manifest ─────────────
  it("I_UNEXPLAINED: a frozen-month active row absent from the manifest with a BACKDATED createdAt opens unexplained_frozen_row", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    // Evade the createdAt > firstFrozenAt discriminator by backdating createdAt.
    const injected = await insertEntry({ amount: "999.00", direction: "income", statementMonth: frozenStart, createdAt: new Date(firstFrozenAt.getTime() - 60_000) });
    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(injected.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("unexplained_frozen_row"); // manifest membership is authoritative, not createdAt
    expect(f[0]!.severity).toBe("critical");
  });

  // ── I7: voiding the illegitimate row → a re-run auto-resolves the finding ─────────
  it("I7: after the post-freeze row is voided, a re-run auto-resolves the finding", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    const firstFrozenAt = frozen.firstFrozenAt as Date;
    const injected = await insertEntry({ amount: "999.00", direction: "income", statementMonth: frozenStart, createdAt: new Date(firstFrozenAt.getTime() + 60_000) });
    await runFrozenIntegrity(ledgerCtx, {});
    expect((await findingsForSource(injected.id))[0]!.status).toBe("open");

    await getDb().ownerLedgerEntry.update({ where: { id: injected.id }, data: { status: "void" } }); // remediate
    await runFrozenIntegrity(ledgerCtx, {});
    const after = await findingsForSource(injected.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("resolved");
    expect(after[0]!.resolvedAt).not.toBeNull();
  });

  // ── I3: an overwritten persisted closingBalanceC → frozen_balance_drift ───────────
  it("I3: an overwritten closingBalanceC (!= firstFrozenClosingC) opens a critical frozen_balance_drift", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    // Tamper the persisted closing balance (a buggy re-freeze / raw write) — the header stays immutable.
    await getDb().ownerStatementPeriod.update({ where: { id: frozen.id }, data: { closingBalanceC: frozen.closingBalanceC + 5000 } });

    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(frozen.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("frozen_balance_drift");
    expect(f[0]!.sourceType).toBe("owner_statement_period");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(frozen.firstFrozenClosingC);
    expect(f[0]!.actualAmountC).toBe(frozen.closingBalanceC + 5000);
  });

  // ── I_OPENING: an opening/net drift also fires frozen_balance_drift (not only closing) ─
  it("I_OPENING: an overwritten openingBalanceC (!= firstFrozenOpeningC) opens frozen_balance_drift", async () => {
    const frozen = await freezeWith([{ amount: "1500.00", direction: "income" }]);
    await getDb().ownerStatementPeriod.update({ where: { id: frozen.id }, data: { openingBalanceC: (frozen.firstFrozenOpeningC ?? 0) - 12345 } });

    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(frozen.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("frozen_balance_drift");
  });

  // ── I4: a manifest row whose live AMOUNT was edited after freeze ──────────────────
  it("I4: a manifest row whose live amount was edited after freeze opens a critical post_freeze_economic_edit", async () => {
    const row = await insertEntry({ amount: "1500.00", direction: "income" });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await getDb().ownerLedgerEntry.update({ where: { id: row.id }, data: { amount: "9999.00" } }); // immutability breach

    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(row.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("post_freeze_economic_edit");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.expectedAmountC).toBe(150000); // manifest baseline
    expect(f[0]!.actualAmountC).toBe(999900); // tampered live amount
  });

  // ── I_FIELDS: a payout-treatment tamper (includeInPayout / direction), amount unchanged ─
  it("I_FIELDS: flipping includeInPayout on a frozen row (amount unchanged) opens a finding", async () => {
    const row = await insertEntry({ amount: "300.00", direction: "expense", includeInPayout: true });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    // Flip includeInPayout false — silently changes the owner payout with amount untouched.
    await getDb().ownerLedgerEntry.update({ where: { id: row.id }, data: { includeInPayout: false } });

    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(row.id);
    expect(f).toHaveLength(1);
    expect(["post_freeze_economic_edit", "manifest_field_mismatch"]).toContain(f[0]!.findingType);
    expect(f[0]!.severity).toBe("critical");
  });

  // ── I_DELETE: a manifest row voided after freeze (money removed from the closed month) ─
  it("I_DELETE: voiding a manifest (frozen) row opens a critical finding (frozen-row deletion breach)", async () => {
    const row = await insertEntry({ amount: "800.00", direction: "income" });
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await getDb().ownerLedgerEntry.update({ where: { id: row.id }, data: { status: "void" } }); // removes owner money from the frozen month

    await runFrozenIntegrity(ledgerCtx, {});
    const f = await findingsForSource(row.id);
    expect(f).toHaveLength(1);
    expect(["post_freeze_economic_edit", "manifest_field_mismatch"]).toContain(f[0]!.findingType);
    expect(f[0]!.severity).toBe("critical");
  });

  // ── Per-unit-frozen-without-combined orphan (durable flag for the combined-scope gap) ─

  /** Freeze the PER-UNIT (apartmentId=APT) scope for FROZEN_M, without a combined freeze. */
  async function freezePerUnitOnly(rows: Array<Parameters<typeof insertEntry>[0]>) {
    for (const r of rows) await insertEntry(r);
    return freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: APT, billingMonth: FROZEN_M });
  }

  // ── I_ORPHAN: per-unit frozen with NO frozen combined sibling → critical finding ──────
  it("I_ORPHAN: a per-unit frozen period with no frozen combined sibling opens a critical per_unit_frozen_without_combined", async () => {
    const perUnit = await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]);
    expect(perUnit.apartmentId).toBe(APT);
    // Precondition: no COMBINED (apartmentId null) frozen period for this owner-month.
    const combined = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER, apartmentId: null, periodMonth: frozenStart, status: "frozen" },
    });
    expect(combined).toBeNull();

    await runFrozenIntegrity(ledgerCtx, {});

    const f = await findingsForSource(perUnit.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.findingType).toBe("per_unit_frozen_without_combined");
    expect(f[0]!.severity).toBe("critical");
    expect(f[0]!.status).toBe("open");
    expect(f[0]!.sourceType).toBe("owner_statement_period");
    expect(f[0]!.checkKind).toBe("frozen_integrity");
    // originalBillingMonth carries the period month (consistent with every other
    // frozen_integrity finding) so the admin findings triage `?month=` filter surfaces it.
    expect(f[0]!.originalBillingMonth!.getTime()).toBe(frozenStart.getTime());
  });

  // ── I_ORPHAN_RESOLVE: freezing the combined sibling auto-resolves the orphan finding ──
  it("I_ORPHAN_RESOLVE: after the combined sibling is frozen, a re-run auto-resolves the orphan finding", async () => {
    const perUnit = await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]);
    await runFrozenIntegrity(ledgerCtx, {});
    expect((await findingsForSource(perUnit.id))[0]!.status).toBe("open");

    // Remediate the orphan: freeze the COMBINED sibling for the same owner-month.
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await runFrozenIntegrity(ledgerCtx, {});

    const after = await findingsForSource(perUnit.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("resolved");
    expect(after[0]!.resolvedAt).not.toBeNull();
  });

  // ── I_ORPHAN_NEG: a per-unit frozen WITH a frozen combined sibling → NO finding ────────
  it("I_ORPHAN_NEG: a per-unit frozen period WITH a frozen combined sibling opens no finding", async () => {
    await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]);
    // Combined sibling frozen too → NOT an orphan.
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });

    await runFrozenIntegrity(ledgerCtx, {});

    const orphanFindings = (await findings()).filter((f) => f.findingType === "per_unit_frozen_without_combined");
    expect(orphanFindings).toHaveLength(0);
  });

  // ── I_ORPHAN_SCOPED: a month-scoped run resolves ONLY its own month's healed orphan ──
  it("I_ORPHAN_SCOPED: a month-scoped run resolves its month's healed orphan, never another month's", async () => {
    // Orphan #1 in FROZEN_M (last month).
    const pmThis = await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]);
    // Orphan #2 in an EARLIER month (two months ago) — must stay untouched by a FROZEN_M run.
    const earlierStart = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 1));
    const EARLIER_M = ym(earlierStart);
    await insertEntry({
      amount: "700.00", direction: "income", statementMonth: earlierStart,
      transactionDate: new Date(Date.UTC(earlierStart.getUTCFullYear(), earlierStart.getUTCMonth(), 5)),
    });
    const pmEarlier = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: APT, billingMonth: EARLIER_M });

    // Full run → BOTH orphan findings open.
    await runFrozenIntegrity(ledgerCtx, {});
    expect((await findingsForSource(pmThis.id))[0]!.status).toBe("open");
    expect((await findingsForSource(pmEarlier.id))[0]!.status).toBe("open");

    // Heal ONLY FROZEN_M (freeze its combined sibling), then run SCOPED to FROZEN_M.
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await runFrozenIntegrity(ledgerCtx, { month: FROZEN_M });

    // FROZEN_M orphan resolved (in scope, healed); EARLIER_M orphan UNTOUCHED (out of scope).
    expect((await findingsForSource(pmThis.id))[0]!.status).toBe("resolved");
    expect((await findingsForSource(pmEarlier.id))[0]!.status).toBe("open");
  });

  // ── I_ORPHAN_MULTI: two per-unit orphans for one owner-month → two DISTINCT findings ──
  it("I_ORPHAN_MULTI: two per-unit orphans for one owner-month open two distinct findings", async () => {
    const APT2 = "6f100000-0000-4000-8000-000000000016"; // 2nd per-unit scope (no FK on apartmentId)
    const pu1 = await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]); // APT
    const pu2 = await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: APT2, billingMonth: FROZEN_M });
    expect(pu1.id).not.toBe(pu2.id);

    await runFrozenIntegrity(ledgerCtx, {});

    const orphanFindings = (await findings()).filter((f) => f.findingType === "per_unit_frozen_without_combined");
    expect(orphanFindings).toHaveLength(2); // distinct sourceId per period → no dedupe collision
    expect(orphanFindings.map((f) => f.sourceId).sort()).toEqual([pu1.id, pu2.id].sort());
  });

  // ── I_ORPHAN_IGNORED: an admin-suppressed orphan is never reopened nor auto-resolved ──
  it("I_ORPHAN_IGNORED: an ignored orphan finding is neither reopened by re-detection nor auto-resolved", async () => {
    const perUnit = await freezePerUnitOnly([{ amount: "1500.00", direction: "income" }]);
    await runFrozenIntegrity(ledgerCtx, {});
    const f0 = (await findingsForSource(perUnit.id))[0]!;
    expect(f0.status).toBe("open");

    // Admin deliberately suppresses it (ignore requires a reason).
    await getDb().ownerLedgerReconciliationFinding.update({
      where: { id: f0.id },
      data: { status: "ignored", reason: "known; tracked elsewhere" },
    });

    // Re-detect while STILL an orphan → upsert must NOT reopen an ignored finding.
    await runFrozenIntegrity(ledgerCtx, {});
    expect((await findingsForSource(perUnit.id))[0]!.status).toBe("ignored");

    // Remediate (freeze the combined sibling) → the dedicated resolve must NOT touch `ignored`.
    await freezeStatementPeriod(billingCtx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: FROZEN_M });
    await runFrozenIntegrity(ledgerCtx, {});
    expect((await findingsForSource(perUnit.id))[0]!.status).toBe("ignored");
  });
});
