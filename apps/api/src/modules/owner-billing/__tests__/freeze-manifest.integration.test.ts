/**
 * freeze-manifest.integration.test.ts — R7 write-once freeze manifest (Task 6).
 *
 * At the FIRST freeze of an owner-statement period scope, freezeStatementPeriod
 * must capture an IMMUTABLE baseline — a header (firstFrozenAt + recorded
 * opening/closing/net cents + freezeRulesetVersion) plus one
 * OwnerStatementFreezeManifestRow per ACTIVE OwnerLedgerEntry (ANY paymentStatus,
 * INCLUDING unpaid; EXCLUDING void) — written ATOMICALLY inside the same freeze
 * $transaction as upsertFrozenPeriod (a frozen period can never exist without its
 * manifest). The paid-only cash-basis snapshotJson is INSUFFICIENT (it omits
 * includeInPayout/sstAmount and every unpaid-active row), which is why the manifest
 * exists — it is the baseline a later reconciliation (R6) diffs live rows against.
 *
 * WRITE-ONCE: a later re-freeze (e.g. a sync bumps a row) may update the persisted
 * snapshot/balances via the monotonic guard, but must NEVER overwrite the manifest
 * rows or the firstFrozen* header.
 *
 * Integration test against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 npx vitest run \
 *     src/modules/owner-billing/__tests__/freeze-manifest.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";

import { freezeStatementPeriod } from "../owner-statement-period.service";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// ── Safety guard — never run against a non-local DB ─────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 7a16; unused by any other suite) ───────────────
const ORG = "7a160000-0000-4000-8000-000000000001";
const OWNER = "7a160000-0000-4000-8000-000000000002";
const PROPERTY = "7a160000-0000-4000-8000-000000000003";
const ACTOR = "7a160000-0000-4000-8000-000000000004";
const APT = "7a160000-0000-4000-8000-0000000000a1";
const L = "7a160000-0000-4000-8000-0000000000a2";
// Fixed ledger-row ids so membership assertions are exact.
const R1_ID = "7a160000-0000-4000-8000-0000000000e1"; // income 1500 paid
const R2_ID = "7a160000-0000-4000-8000-0000000000e2"; // income  800 paid (sst null)
const R3_ID = "7a160000-0000-4000-8000-0000000000e3"; // income  100 UNPAID (manifest incl.)
const R4_ID = "7a160000-0000-4000-8000-0000000000e4"; // expense 300 paid (sst 24.00)
const R5_ID = "7a160000-0000-4000-8000-0000000000e5"; // income  999 VOID (manifest excl.)

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" };

// Date-RELATIVE past (closed) month so the freeze guard (only PAST months freeze)
// is satisfied on any run date.
const NOW = new Date();
const PAST_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const PAST_M = `${PAST_START.getUTCFullYear()}-${String(PAST_START.getUTCMonth() + 1).padStart(2, "0")}`;
const dayInPast = (d: number): Date =>
  new Date(Date.UTC(PAST_START.getUTCFullYear(), PAST_START.getUTCMonth(), d));

async function insertEntry(o: {
  id?: string;
  apartmentId: string;
  statementMonth: Date;
  transactionDate: Date;
  direction: string;
  amount: string;
  paymentStatus?: string;
  status?: string;
  sstAmount?: string | null;
  category?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      ...(o.id ? { id: o.id } : {}),
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      apartmentId: o.apartmentId,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: o.direction,
      category: o.category ?? (o.direction === "income" ? "rental_income" : "management_fee"),
      amount: o.amount,
      sstAmount: o.sstAmount ?? null,
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

async function seedBaseLedger() {
  await insertEntry({ id: R1_ID, apartmentId: APT, statementMonth: PAST_START, transactionDate: dayInPast(3), direction: "income", amount: "1500.00" });
  await insertEntry({ id: R2_ID, apartmentId: APT, statementMonth: PAST_START, transactionDate: dayInPast(5), direction: "income", amount: "800.00" });
  await insertEntry({ id: R3_ID, apartmentId: APT, statementMonth: PAST_START, transactionDate: dayInPast(10), direction: "income", amount: "100.00", paymentStatus: "unpaid" });
  await insertEntry({ id: R4_ID, apartmentId: APT, statementMonth: PAST_START, transactionDate: dayInPast(12), direction: "expense", amount: "300.00", sstAmount: "24.00" });
  await insertEntry({ id: R5_ID, apartmentId: APT, statementMonth: PAST_START, transactionDate: dayInPast(15), direction: "income", amount: "999.00", status: "void" });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementFreezeManifestRow.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("owner-statement-period.service — write-once freeze manifest (R7, integration)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG,
        name: "7A16 Freeze Manifest Org",
        slug: "7a16-freeze-manifest-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await db.party.create({
      data: { id: OWNER, organizationId: ORG, displayName: "Manifest Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "Manifest Property",
        propertyCode: "7A16-P1",
        propertyType: "apartment",
        addressLine1: "1 Manifest St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT, organizationId: ORG, propertyId: PROPERTY, unitCode: "M-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L,
        organizationId: ORG,
        apartmentId: APT,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER,
      },
    });
  });

  // Fresh ledger + no frozen periods/manifest before EACH test so a re-freeze test's
  // mutation cannot leak into another test.
  beforeEach(async () => {
    const db = getDb();
    await db.ownerStatementFreezeManifestRow.deleteMany({ where: { organizationId: ORG } });
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
    await seedBaseLedger();
  });

  afterAll(cleanup);

  // ── B1/B2/B3/B5: first freeze captures the write-once manifest + header ──────────
  it("first freeze captures one manifest row per ACTIVE entry (incl. unpaid, excl. void) and sets firstFrozen* header", async () => {
    const period = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });

    const rows = await getDb().ownerStatementFreezeManifestRow.findMany({
      where: { organizationId: ORG, ownerStatementPeriodId: period.id },
    });

    // B2: one row per ACTIVE entry (R1..R4); the VOID row (R5) is excluded.
    expect(rows.length).toBe(4);
    const byLedgerId = new Map(rows.map((r) => [r.ledgerEntryId, r]));
    expect([...byLedgerId.keys()].sort()).toEqual([R1_ID, R2_ID, R3_ID, R4_ID].sort());
    expect(byLedgerId.has(R5_ID)).toBe(false); // void never captured

    // B5: the UNPAID-active row IS in the manifest (the paid-only snapshot omits it).
    const r3 = byLedgerId.get(R3_ID)!;
    expect(r3.paymentStatus).toBe("unpaid");
    expect(r3.amountC).toBe(10000);

    // B3: economic fields captured faithfully — R2 income 800.00, sst null.
    const r2 = byLedgerId.get(R2_ID)!;
    expect(r2.amountC).toBe(80000);
    expect(r2.direction).toBe("income");
    expect(r2.includeInPayout).toBe(false); // income → not in payout (derived at seed)
    expect(r2.paymentStatus).toBe("paid");
    expect(r2.sstAmountC).toBeNull();
    expect(r2.category).toBe("rental_income");
    expect(r2.paidBy).toBe("kaen");
    expect(r2.sourceType).toBe("manual");
    expect(r2.statementMonth.getTime()).toBe(PAST_START.getTime());
    expect(r2.periodMonth.getTime()).toBe(PAST_START.getTime());
    expect(r2.ownerPartyId).toBe(OWNER);
    expect(r2.apartmentId).toBeNull(); // combined-scope freeze → scope apartmentId (null)
    // ledgerUpdatedAtAtFreeze snapshots the row's updatedAt as read at freeze.
    const r2Live = await getDb().ownerLedgerEntry.findUniqueOrThrow({ where: { id: R2_ID } });
    expect(r2.ledgerUpdatedAtAtFreeze.getTime()).toBe(r2Live.updatedAt.getTime());

    // B3: expense R4 300.00 with sst 24.00 → cents + includeInPayout true.
    const r4 = byLedgerId.get(R4_ID)!;
    expect(r4.amountC).toBe(30000);
    expect(r4.sstAmountC).toBe(2400);
    expect(r4.direction).toBe("expense");
    expect(r4.includeInPayout).toBe(true);

    // B1: write-once header set == the persisted balances; ruleset version 1.
    expect(period.firstFrozenAt).not.toBeNull();
    expect(period.firstFrozenOpeningC).toBe(period.openingBalanceC);
    expect(period.firstFrozenClosingC).toBe(period.closingBalanceC);
    expect(period.firstFrozenNetC).toBe(period.netPayoutC);
    expect(period.freezeRulesetVersion).toBe(1);
  });

  // ── B4: re-freeze is WRITE-ONCE — the manifest rows + firstFrozen* header stay
  // IMMUTABLE even when the monotonic guard legitimately updates the persisted
  // snapshot/balances on the re-freeze. ───────────────────────────────────────────
  it("re-freeze leaves the manifest + firstFrozen* header UNCHANGED while balances update", async () => {
    const first = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });
    const firstClosingC = first.closingBalanceC;
    const firstNetC = first.netPayoutC;
    const firstFrozenAt = first.firstFrozenAt!;
    expect(firstFrozenAt).not.toBeNull();

    const beforeRows = await getDb().ownerStatementFreezeManifestRow.findMany({
      where: { organizationId: ORG, ownerStatementPeriodId: first.id },
    });
    expect(beforeRows.length).toBe(4);
    expect(beforeRows.find((r) => r.ledgerEntryId === R2_ID)!.amountC).toBe(80000);

    // A later "sync" bumps R2 (800 → 900): raises closing by 100 AND bumps updatedAt so
    // the monotonic guard ACCEPTS the re-freeze — the HARDER write-once case (the freeze
    // DOES rewrite balances/snapshot, yet the manifest/header must not move).
    await new Promise((r) => setTimeout(r, 10));
    await getDb().ownerLedgerEntry.update({ where: { id: R2_ID }, data: { amount: "900.00" } });

    const second = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });

    // Same period row; balances DID move on re-freeze (snapshot/balances still update).
    expect(second.id).toBe(first.id);
    expect(second.closingBalanceC).toBe(firstClosingC + 10000);

    // Write-once HEADER: firstFrozen* + firstFrozenAt UNCHANGED from the first freeze.
    expect(second.firstFrozenClosingC).toBe(firstClosingC);
    expect(second.firstFrozenNetC).toBe(firstNetC);
    expect(new Date(second.firstFrozenAt!).getTime()).toBe(new Date(firstFrozenAt).getTime());

    // Write-once MANIFEST: still exactly 4 rows (no re-freeze duplication); R2's captured
    // amount stays the ORIGINAL 80000, NOT the bumped 90000.
    const afterRows = await getDb().ownerStatementFreezeManifestRow.findMany({
      where: { organizationId: ORG, ownerStatementPeriodId: first.id },
    });
    expect(afterRows.length).toBe(4);
    const r2After = afterRows.filter((r) => r.ledgerEntryId === R2_ID);
    expect(r2After.length).toBe(1);
    expect(r2After[0]!.amountC).toBe(80000);
  });

  // ── Remediation (spec R7 "no backfill"): a period frozen BEFORE this feature shipped
  // has a row but firstFrozenAt = null and ZERO manifest rows. Its first post-deploy
  // re-freeze must MINT the manifest once. This pins the gate to firstFrozenAt (NOT row
  // existence) — a `!existing` gate would treat this as a re-freeze and never remediate.
  it("mints the manifest once for a pre-existing frozen period whose firstFrozenAt is null (remediation)", async () => {
    const PRE_ID = "7a160000-0000-4000-8000-0000000000f1";
    await getDb().ownerStatementPeriod.create({
      data: {
        id: PRE_ID,
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PAST_START,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:${PAST_M}`,
        sourceMaxUpdatedAt: new Date(0), // epoch → the seeded rows' max is newer (re-freeze accepted)
        openingBalanceC: 0,
        closingBalanceC: 0,
        netPayoutC: 0,
        firstFrozenAt: null, // the pre-manifest marker
      },
    });
    // Precondition: no manifest, no header yet.
    expect(
      await getDb().ownerStatementFreezeManifestRow.count({
        where: { organizationId: ORG, ownerStatementPeriodId: PRE_ID },
      }),
    ).toBe(0);

    const remediated = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });

    // Same row (found by idempotencyKey — no duplicate), now with the header minted.
    expect(remediated.id).toBe(PRE_ID);
    expect(remediated.firstFrozenAt).not.toBeNull();
    expect(remediated.firstFrozenClosingC).toBe(remediated.closingBalanceC);

    // Manifest minted ONCE for the active rows (R1..R4).
    const rows = await getDb().ownerStatementFreezeManifestRow.findMany({
      where: { organizationId: ORG, ownerStatementPeriodId: PRE_ID },
    });
    expect(rows.length).toBe(4);
  });

  // ── Frozen-integrity baseline (R6): a remediation re-freeze whose monotonic guard
  // REJECTS. The persisted balances stay OLD (upsertFrozenPeriod keeps the newer
  // snapshot and returns the existing row UNCHANGED), yet the local recompute diverges.
  // The write-once firstFrozen* header MUST be sourced from that PERSISTED period row
  // (`p` from upsertFrozenPeriod), NOT the local recompute consts — otherwise
  // firstFrozenClosingC != closingBalanceC at mint time, an inconsistent baseline that
  // makes the R6 frozen-integrity check fire a FALSE `frozen_balance_drift`. ──────────
  it("sources firstFrozen* from the PERSISTED period (not the recompute) on a guard-REJECTED remediation re-freeze", async () => {
    const PRE_ID = "7a160000-0000-4000-8000-0000000000f2";
    // Distinctive OLD persisted balances, provably OUTSIDE the seeded rows' recompute
    // range (max |balance| = 1500+800+100+300+24 = 2724.00 = 272400c, far below these),
    // so a recompute-sourced header is unambiguously != these persisted values.
    const OLD_OPENING_C = 7_000_001;
    const OLD_CLOSING_C = 7_000_002;
    const OLD_NET_C = 7_000_003;
    await getDb().ownerStatementPeriod.create({
      data: {
        id: PRE_ID,
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PAST_START,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:${PAST_M}`,
        // FAR FUTURE → existing.sourceMaxUpdatedAt >= incoming recompute max, so the
        // monotonic guard REJECTS the balance update: persisted balances stay OLD.
        sourceMaxUpdatedAt: new Date(Date.UTC(2999, 0, 1)),
        openingBalanceC: OLD_OPENING_C,
        closingBalanceC: OLD_CLOSING_C,
        netPayoutC: OLD_NET_C,
        firstFrozenAt: null, // pre-manifest marker → takes the first-freeze mint path
      },
    });

    const remediated = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });

    // Same row; the header was minted (the first-freeze mint path ran).
    expect(remediated.id).toBe(PRE_ID);
    expect(remediated.firstFrozenAt).not.toBeNull();

    // The guard REALLY rejected — persisted balances stayed the OLD values (NOT the
    // recompute). Guards against a vacuous test: if the upsert ever ACCEPTED here,
    // persisted would EQUAL the recompute and the header check below could not tell them
    // apart. These pass under both the buggy (recompute-sourced) and fixed code.
    expect(remediated.openingBalanceC).toBe(OLD_OPENING_C);
    expect(remediated.closingBalanceC).toBe(OLD_CLOSING_C);
    expect(remediated.netPayoutC).toBe(OLD_NET_C);

    // THE INVARIANT: firstFrozen* == the PERSISTED period balances (a consistent R6
    // baseline), which here are the OLD values — NOT the local recompute. Under the
    // recompute-sourced bug firstFrozen* equal the (diverging) recompute → these fail.
    expect(remediated.firstFrozenOpeningC).toBe(remediated.openingBalanceC);
    expect(remediated.firstFrozenClosingC).toBe(remediated.closingBalanceC);
    expect(remediated.firstFrozenNetC).toBe(remediated.netPayoutC);
    expect(remediated.firstFrozenOpeningC).toBe(OLD_OPENING_C);
    expect(remediated.firstFrozenClosingC).toBe(OLD_CLOSING_C);
    expect(remediated.firstFrozenNetC).toBe(OLD_NET_C);
  });

  // ── F1 hardening: F1's OLD sentinels are all LARGER than the recompute, so a wrong
  // "max(persisted, recompute) wins" / "larger-magnitude wins" mutant would pass F1
  // unchanged (old-and-bigger always wins). Pin the header to the PERSISTED value in
  // the OTHER direction — OLD balances SMALLER than the recompute (and negative) — so
  // ONLY a faithful `p`-sourced header (not max, not recompute) yields them. The seeded
  // recompute is opening 0 / closing +207600 / net +207600 (all ≥ 0), so a negative
  // persisted value is unreachable by recompute OR max. ──────────────────────────────
  it("sources firstFrozen* from the persisted period when the persisted balances are SMALLER/negative than the recompute (rules out a max/recompute-sourced mutant)", async () => {
    const PRE_ID = "7a160000-0000-4000-8000-0000000000f3";
    const OLD_OPENING_C = -1;
    const OLD_CLOSING_C = -500;
    const OLD_NET_C = -777;
    await getDb().ownerStatementPeriod.create({
      data: {
        id: PRE_ID,
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: PAST_START,
        status: "frozen",
        idempotencyKey: `ownerstmt:${OWNER}:${PAST_M}`,
        sourceMaxUpdatedAt: new Date(Date.UTC(2999, 0, 1)), // guard REJECTS → persisted stays OLD
        openingBalanceC: OLD_OPENING_C,
        closingBalanceC: OLD_CLOSING_C,
        netPayoutC: OLD_NET_C,
        firstFrozenAt: null,
      },
    });

    const remediated = await freezeStatementPeriod(ctx, { ownerPartyId: OWNER, apartmentId: null, billingMonth: PAST_M });

    // Guard rejected — persisted stayed the OLD (smaller/negative) values.
    expect(remediated.openingBalanceC).toBe(OLD_OPENING_C);
    expect(remediated.closingBalanceC).toBe(OLD_CLOSING_C);
    expect(remediated.netPayoutC).toBe(OLD_NET_C);

    // Header == the persisted OLD values …
    expect(remediated.firstFrozenOpeningC).toBe(OLD_OPENING_C);
    expect(remediated.firstFrozenClosingC).toBe(OLD_CLOSING_C);
    expect(remediated.firstFrozenNetC).toBe(OLD_NET_C);
    // … and NEGATIVE, so they cannot be the (≥0) recompute NOR max(persisted, recompute)
    // — both of which are the larger, non-negative recompute here.
    expect(remediated.firstFrozenOpeningC).toBeLessThan(0);
    expect(remediated.firstFrozenClosingC).toBeLessThan(0);
    expect(remediated.firstFrozenNetC).toBeLessThan(0);
  });
});
