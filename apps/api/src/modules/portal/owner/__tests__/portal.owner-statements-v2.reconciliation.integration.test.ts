/**
 * Portal owner-live GET /reconciliation — Phase-3 (rent-reclassification) owner-payable
 * waterfall (spec R15/R18). READ-ONLY, own-data-only, flag-gated on
 * ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (same router as the sibling
 * portal.owner-statements-v2.integration.test.ts — its flag/guard/own-data-only
 * coverage is NOT re-proven exhaustively here beyond what this endpoint adds).
 *
 * SECURITY-CRITICAL + MONEY-CRITICAL integration test (real LOCAL Postgres, opt-in
 * RUN_INTEGRATION=1). Fixed disjoint UUID prefix `fee10000…` (checked against every
 * other suite's prefix — unique to this file).
 *
 * DESIGN NOTE: resolveOwnerBalance's openingPayableC (broughtForward) is a genuinely
 * CUMULATIVE running balance across every PRIOR month for that owner (by design —
 * this is correct product behavior, not a bug). Each scenario below therefore gets
 * its OWN dedicated owner party (never reusing an owner across scenarios that assert
 * exact aggregate values) so scenarios can never cross-contaminate each other's
 * opening balance. OwnerLedgerEntry.propertyId/apartmentId/ownerPartyId are all
 * PLAIN columns (no FK — see schema.prisma's own comments), so no real
 * Property/Apartment/Listing rows are needed at all; a fixed UUID constant suffices.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/portal/owner/__tests__/portal.owner-statements-v2.reconciliation.integration.test.ts \
 *     --no-coverage
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal.middleware";
import { portalOwnerStatementsV2Routes } from "../portal.owner-statements-v2.routes";

const RUN = process.env.RUN_INTEGRATION === "1";

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix fee1… — unique to this suite) ──────────────────
const ORG = "fee10000-0000-4000-8000-000000000001";
const ACTOR = "fee10000-0000-4000-8000-000000000006";
// One dedicated owner per scenario that asserts exact aggregate values (see DESIGN
// NOTE above) — never reused across scenarios.
const OWNER_A = "fee10000-0000-4000-8000-000000000002"; // Cycle 1 (income-only tracer)
const OWNER_B = "fee10000-0000-4000-8000-000000000003"; // cross-owner-isolation companion
const OWNER_RICH = "fee10000-0000-4000-8000-000000000007"; // Cycle 2 (full waterfall)
const OWNER_FROZEN = "fee10000-0000-4000-8000-000000000008"; // frozen-period cycle
const OWNER_MULTI = "fee10000-0000-4000-8000-000000000009"; // per-unit legitimate-discrepancy cycle
const OWNER_LEGACY = "fee10000-0000-4000-8000-00000000000a"; // legacy null-settlementKind + negative-balance cycle
const OWNER_ZERO = "fee10000-0000-4000-8000-00000000000b"; // zero-activity — deliberately NO Party row seeded
const OWNER_DEPOSIT = "fee10000-0000-4000-8000-00000000000c"; // Cycle 9 (deposit-inclusive collections — R15 identity)
const OWNER_ATTRIB = "fee10000-0000-4000-8000-00000000000d"; // Cycle 10 (per-unit settlement fully attributable → flag false)
const APT_MULTI = "fee10000-0000-4000-8000-0000000000a1"; // OWNER_MULTI's unit
const APT_ATTRIB = "fee10000-0000-4000-8000-0000000000a7"; // OWNER_ATTRIB's unit (its own per-unit remittance)
const APT_FOREIGN = "fee10000-0000-4000-8000-0000000000f1"; // tagged on OWNER_B's row; queried by OWNER_A
const FROZEN_PERIOD = "fee10000-0000-4000-8000-0000000000d1";
// OWNER_DEPOSIT's real object graph (a period-deposit must be summed from the
// Deposit table over the owner's non-archived Listing — resolveOwnerBalance folds
// it into carriedForward, so the R15 waterfall must account for it too).
const PROP_DEP = "fee10000-0000-4000-8000-0000000000e1";
const APT_DEP = "fee10000-0000-4000-8000-0000000000e2";
const L_DEP = "fee10000-0000-4000-8000-0000000000e3";
const TENANT_DEP = "fee10000-0000-4000-8000-0000000000e4";
const TENANCY_DEP = "fee10000-0000-4000-8000-0000000000e5";
const DEPOSIT_ID = "fee10000-0000-4000-8000-0000000000e6";

// One shared past month for every scenario — safe because each scenario's owner is
// dedicated (no cross-scenario history to accumulate into openingPayableC).
const NOW = new Date();
const MONTH_FIRST = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const MONTH_M = `${MONTH_FIRST.getUTCFullYear()}-${String(MONTH_FIRST.getUTCMonth() + 1).padStart(2, "0")}`;

function ownerSession(partyId: string, orgId = ORG): PortalSessionPayload {
  return { userId: `user-${partyId.slice(0, 8)}`, orgId, role: "viewer", userType: "owner", partyId, iat: 0, absoluteExp: 0 };
}
const agentSession: PortalSessionPayload = {
  userId: "user-agent", orgId: ORG, role: "viewer", userType: "agent",
  partyId: "fee10000-0000-4000-8000-0000000000ae", iat: 0, absoluteExp: 0,
};

/** Build the app the way portal/index.ts mounts it: owner-guard + router. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner-live/*", portalUserTypeGuard("owner"));
  app.route("/owner-live", portalOwnerStatementsV2Routes);
  return app;
}

async function insertLedgerRow(o: {
  ownerPartyId: string;
  apartmentId?: string | null;
  statementMonth: Date;
  direction: "income" | "expense" | "payout";
  category: string;
  amount: string;
  sstAmount?: string | null;
  includeInPayout?: boolean;
  status?: string;
  settlementKind?: string | null;
  reversalOfEntryId?: string | null;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: o.ownerPartyId,
      apartmentId: o.apartmentId ?? null,
      statementMonth: o.statementMonth,
      transactionDate: o.statementMonth,
      direction: o.direction,
      category: o.category,
      amount: o.amount,
      sstAmount: o.sstAmount ?? null,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      includeInPayout: o.includeInPayout ?? true,
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      settlementKind: o.settlementKind ?? null,
      reversalOfEntryId: o.reversalOfEntryId ?? null,
      createdById: ACTOR,
      updatedById: ACTOR,
    },
  });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  // FK-safe order for the Cycle-9 deposit graph: deposit → tenancy → listing →
  // apartment → property, all BEFORE party/organization.
  await db.deposit.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Owner Payable Reconciliation Org", slug: "owner-payable-recon", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  for (const [id, name] of [
    [OWNER_A, "Owner A"], [OWNER_B, "Owner B"], [OWNER_RICH, "Owner Rich"],
    [OWNER_FROZEN, "Owner Frozen"], [OWNER_MULTI, "Owner Multi"], [OWNER_LEGACY, "Owner Legacy"],
    [OWNER_DEPOSIT, "Owner Deposit"], [TENANT_DEP, "Tenant Deposit"], [OWNER_ATTRIB, "Owner Attrib"],
    // OWNER_ZERO deliberately NOT seeded as a Party — proves the established
    // "no ownerPartyId existence check" convention (getOwnerAccountService's own
    // docstring) also holds for this new endpoint: an unknown owner degrades to a
    // clean zero result, never a crash.
  ] as const) {
    await db.party.create({
      data: { id, organizationId: ORG, displayName: name, partyType: "individual", status: "active" },
    });
  }

  // ── OWNER_A — income only (Cycle 1 tracer bullet) ────────────────────────────
  await insertLedgerRow({
    ownerPartyId: OWNER_A, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "1000.00",
  });

  // ── OWNER_B — cross-owner-isolation companion, SAME month, tagged with a real
  // apartmentId (APT_FOREIGN) so it doubles as the "foreign apartmentId → no leak"
  // fixture when OWNER_A queries with that same apartmentId. ───────────────────
  await insertLedgerRow({
    ownerPartyId: OWNER_B, apartmentId: APT_FOREIGN, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "250.00",
  });

  // ── OWNER_RICH — full waterfall (Cycle 2) ────────────────────────────────────
  // income 1000.00; SST-bearing pass-through expense 80.00+20.00 SST; a
  // non-pass-through expense (includeInPayout=false) that must NOT reduce the
  // payable; a void income row that must be fully excluded; a remittance
  // 500.00 + an offset 200.00; a reversal of EACH (150.00 / 50.00) — proving
  // reversalOfEntryId is checked BEFORE settlementKind (a reversed offset must
  // land in reversalsC, not offsetDeductionsC).
  //   openingPayableC=0, collectionsC=100000, offsetDeductionsC=20000,
  //   passThroughExpensesC=10000, grossRemittancesC=50000, reversalsC=20000,
  //   closingPayableC=40000 → R15 LHS = 0+100000−20000−10000−50000+20000=40000
  //   === closingPayableC → balanced.
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "1000.00",
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "expense", category: "sinking_fund", amount: "80.00", sstAmount: "20.00", includeInPayout: true,
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "expense", category: "quit_rent", amount: "999.00", includeInPayout: false,
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "5000.00", status: "void",
  });
  const richRemittance = await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "500.00", includeInPayout: false,
    settlementKind: "OWNER_REMITTANCE",
  });
  const richOffset = await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "200.00", includeInPayout: false,
    settlementKind: "OWNER_RECEIVABLE_OFFSET",
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "150.00", includeInPayout: false,
    settlementKind: "OWNER_REMITTANCE", reversalOfEntryId: richRemittance.id,
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_RICH, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "50.00", includeInPayout: false,
    settlementKind: "OWNER_RECEIVABLE_OFFSET", reversalOfEntryId: richOffset.id,
  });

  // ── OWNER_FROZEN — a frozen OwnerStatementPeriod, zero ledger rows (isolates
  // the period-lookup/periodRemainingPayableC mechanics from any waterfall math:
  // every waterfall term is trivially 0/0, balanced=true). ─────────────────────
  await db.ownerStatementPeriod.create({
    data: {
      id: FROZEN_PERIOD, organizationId: ORG, ownerPartyId: OWNER_FROZEN, apartmentId: null,
      periodMonth: MONTH_FIRST, status: "frozen", issuedAt: new Date(),
      openingBalanceC: 0, closingBalanceC: 99900, netPayoutC: 99900,
      firstFrozenAt: new Date(), firstFrozenOpeningC: 0, firstFrozenClosingC: 99900, firstFrozenNetC: 99900,
      freezeRulesetVersion: 1,
      idempotencyKey: `ownerstmt:${OWNER_FROZEN}:${MONTH_M}`, sourceMaxUpdatedAt: new Date(),
    },
  });

  // ── OWNER_MULTI — per-unit request with OWNER-WIDE (apartmentId=null) remittance
  // activity: proves a legitimate nonzero discrepancyC when the per-unit view can't
  // see money that was recorded combined-scope (spec-mandated design, never fudged). ─
  await insertLedgerRow({
    ownerPartyId: OWNER_MULTI, apartmentId: APT_MULTI, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "800.00",
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_MULTI, apartmentId: null, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "300.00", includeInPayout: false,
    settlementKind: "OWNER_REMITTANCE",
  });

  // ── OWNER_ATTRIB (Cycle 10) — per-unit request whose ONLY settlement carries the
  // SAME apartmentId (a genuine per-unit remittance). Proves scopeIncompleteFor-
  // Settlements is PRECISE (false here), not the lazy "apartmentId != null": the
  // settlement IS attributable to this apartment, the unit-scoped closing already
  // reflects it, so balanced stays authoritative and true. ────────────────────
  await insertLedgerRow({
    ownerPartyId: OWNER_ATTRIB, apartmentId: APT_ATTRIB, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "800.00",
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_ATTRIB, apartmentId: APT_ATTRIB, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "300.00", includeInPayout: false,
    settlementKind: "OWNER_REMITTANCE",
  });

  // ── OWNER_LEGACY — a direction=payout row with settlementKind=NULL (a manual/
  // sync payout predating Phase-2 settlement tracking) — invisible to the R15
  // waterfall by the task's own spec (settlementKind != null), producing a real,
  // expected, un-fudged discrepancyC; also drives closingPayableC negative
  // (KAEN paid out more than was collected) to prove no accidental abs()/sign
  // coercion anywhere in the R15 arithmetic. ───────────────────────────────────
  await insertLedgerRow({
    ownerPartyId: OWNER_LEGACY, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "100.00",
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_LEGACY, statementMonth: MONTH_FIRST,
    direction: "payout", category: "owner_payout", amount: "500.00", includeInPayout: false,
    settlementKind: null,
  });

  // ── OWNER_DEPOSIT (Cycle 9) — income 1000 + a RM500 security deposit collected
  // in-month. resolveOwnerBalance folds the deposit into carriedForward
  // (closingPayableC) as a non-income cash-in but keeps it OUT of periodGross
  // (collectionsC). The R15 waterfall must therefore also account for it on the
  // collections side, else a perfectly healthy deposit-month reads balanced:false.
  // Needs the real object graph (Property→Apartment→Listing[owner,not-archived]→
  // Tenancy+tenant Party→Deposit) because the deposit sum is table-driven. ───────
  await db.property.create({
    data: {
      id: PROP_DEP, organizationId: ORG, name: "Prop Dep", propertyCode: "FEE1-PD", propertyType: "apartment",
      addressLine1: "3 St", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT_DEP, organizationId: ORG, propertyId: PROP_DEP, unitCode: "D-1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: L_DEP, organizationId: ORG, apartmentId: APT_DEP, listingType: "whole", occupancyStatus: "occupied",
      listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_DEPOSIT,
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_DEP, organizationId: ORG, propertyId: PROP_DEP, unitId: L_DEP, tenantPartyId: TENANT_DEP,
      tenancyCode: "FEE1-T1", status: "active", billingStatus: "current",
      startDate: MONTH_FIRST, monthlyRentAmount: "1000.00",
    },
  });
  await db.deposit.create({
    data: {
      id: DEPOSIT_ID, organizationId: ORG, tenancyId: TENANCY_DEP, partyId: TENANT_DEP, unitId: L_DEP,
      type: "security", amount: "500.00", status: "held",
      // createdAt drives the deposit's collection-month bucket — mid-month.
      createdAt: new Date(Date.UTC(MONTH_FIRST.getUTCFullYear(), MONTH_FIRST.getUTCMonth(), 15)),
    },
  });
  await insertLedgerRow({
    ownerPartyId: OWNER_DEPOSIT, apartmentId: APT_DEP, statementMonth: MONTH_FIRST,
    direction: "income", category: "rental_income", amount: "1000.00",
  });
}

describe.skipIf(!RUN)("portal owner-live GET /reconciliation (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
  });

  // ── Cycle 1: tracer bullet — income only, everything else legitimately zero ──
  it("[Cycle1] income-only month: collections/closing wired, other terms zero, balanced, no period row fallback", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_A,
      apartmentId: null,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 100000,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 0,
      reversalsC: 0,
      closingPayableC: 100000,
      balanced: true,
      discrepancyC: 0,
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 100000,
      scopeIncompleteForSettlements: false, // owner-wide request → always false
    });
  });

  it("[Cycle1 companion] flag OFF → 404 (no shape leak)", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(404);
  });

  // ── Cycle 2: full waterfall — SST expense, non-passthrough + void exclusion, ──
  // remittance+offset+reversal-of-EACH (branch-order proof) ────────────────────
  it("[Cycle2] full waterfall: SST-aware pass-through expense, void/non-passthrough excluded, reversal-of-offset lands in reversalsC not offsetDeductionsC, balances", async () => {
    const res = await makeApp(ownerSession(OWNER_RICH)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_RICH,
      apartmentId: null,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 100000,
      offsetDeductionsC: 20000,
      passThroughExpensesC: 10000,
      grossRemittancesC: 50000,
      reversalsC: 20000,
      closingPayableC: 40000,
      balanced: true,
      discrepancyC: 0,
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 40000,
      scopeIncompleteForSettlements: false, // owner-wide request → always false
    });
  });

  // ── Cycle 3: frozen period ────────────────────────────────────────────────────
  it("[Cycle3] frozen period: frozenNetPayableAtCloseC = firstFrozenNetC, remainingPayableNowC computed (zero allocations ⇒ netPayoutC)", async () => {
    const res = await makeApp(ownerSession(OWNER_FROZEN)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.periodStatus).toBe("frozen");
    expect(body.data.frozenNetPayableAtCloseC).toBe(99900);
    expect(body.data.remainingPayableNowC).toBe(99900);
    expect(body.data.balanced).toBe(true);
    expect(body.data.discrepancyC).toBe(0);
  });

  // ── Cycle 4: validation ────────────────────────────────────────────────────────
  describe("[Cycle4] validation", () => {
    it("missing month → 400", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation`);
      expect(res.status).toBe(400);
    });
    it("malformed month → 400 (no 500)", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=not-a-month`);
      expect(res.status).toBe(400);
    });
    it("out-of-range month component (2026-13 / 2026-00) → 400, not a silently-rolled adjacent month", async () => {
      const thirteen = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=2026-13`);
      expect(thirteen.status).toBe(400);
      const zero = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=2026-00`);
      expect(zero.status).toBe(400);
    });
    it("malformed apartmentId → 400 (no Postgres uuid-parse 500)", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(
        `/owner-live/reconciliation?month=${MONTH_M}&apartmentId=not-a-uuid`,
      );
      expect(res.status).toBe(400);
    });
    it("empty apartmentId → treated as absent (combined scope), not a 400", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=${MONTH_M}&apartmentId=`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.apartmentId).toBeNull();
    });
  });

  // ── Cycle 5: permission / own-data-only ───────────────────────────────────────
  describe("[Cycle5] permission / own-data-only", () => {
    it("agent session → 403", async () => {
      const res = await makeApp(agentSession).request(`/owner-live/reconciliation?month=${MONTH_M}`);
      expect(res.status).toBe(403);
    });
    it("owner A never sees owner B's amounts (own-data-only, exact-value check)", async () => {
      const resA = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
      const bodyA = await resA.json();
      expect(bodyA.data.collectionsC).toBe(100000); // owner A's own 1000.00, never B's 250.00

      const resB = await makeApp(ownerSession(OWNER_B)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
      const bodyB = await resB.json();
      expect(bodyB.data.collectionsC).toBe(25000); // owner B's own 250.00, never A's 1000.00
    });
    it("a real apartmentId belonging to a DIFFERENT owner degrades to zero (no leak)", async () => {
      // APT_FOREIGN is OWNER_B's real, populated apartmentId. OWNER_A querying with
      // it must match NOTHING (org+owner+apartment compound filter), not leak B's row.
      const res = await makeApp(ownerSession(OWNER_A)).request(
        `/owner-live/reconciliation?month=${MONTH_M}&apartmentId=${APT_FOREIGN}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.collectionsC).toBe(0);
      expect(body.data.closingPayableC).toBe(0);
      expect(body.data.balanced).toBe(true);
    });
  });

  // ── Cycle 6: zero-activity month (owner with NO Party row at all) ────────────
  it("[Cycle6] zero-activity month, unknown ownerPartyId (no Party row): all zeros, balanced, no crash", async () => {
    const res = await makeApp(ownerSession(OWNER_ZERO)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_ZERO,
      apartmentId: null,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 0,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 0,
      reversalsC: 0,
      closingPayableC: 0,
      balanced: true,
      discrepancyC: 0,
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 0,
      scopeIncompleteForSettlements: false, // owner-wide request → always false
    });
  });

  // ── Cycle 7: per-unit request with owner-wide remittance → legitimate discrepancy ─
  it("[Cycle7] per-unit apartmentId: owner-wide remittance is invisible to this unit's closingPayableC yet still deducted in the waterfall → balanced=false, exact discrepancyC, NEVER fudged", async () => {
    const res = await makeApp(ownerSession(OWNER_MULTI)).request(
      `/owner-live/reconciliation?month=${MONTH_M}&apartmentId=${APT_MULTI}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_MULTI,
      apartmentId: APT_MULTI,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 80000,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 30000, // owner-wide remittance, NOT apartment-filtered by design
      reversalsC: 0,
      closingPayableC: 80000, // resolveOwnerBalance's OWN apartment filter excludes the null-apartmentId remittance
      balanced: false,
      discrepancyC: -30000, // signed: LHS(50000) − closingPayableC(80000)
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 80000,
      // The remittance is combined-scope (apartmentId=null), NOT attributable to
      // APT_MULTI → the settlement scope is incomplete for this per-unit view, so
      // balanced/discrepancyC here are NOT an authoritative integrity result.
      scopeIncompleteForSettlements: true,
    });
  });

  // ── Cycle 8: legacy settlementKind=null payout + negative balance ────────────
  it("[Cycle8] legacy settlementKind=null payout excluded from the split → real discrepancyC; negative closingPayableC handled without sign coercion", async () => {
    const res = await makeApp(ownerSession(OWNER_LEGACY)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_LEGACY,
      apartmentId: null,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 10000,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 0, // the settlementKind=null payout is invisible to this query by spec
      reversalsC: 0,
      closingPayableC: -40000, // 10000 (income) − 50000 (legacy payout) — genuinely negative
      balanced: false,
      discrepancyC: 50000, // LHS(10000) − closingPayableC(−40000) = the untracked legacy deduction
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: -40000,
      // owner-wide request → false EVEN THOUGH balanced:false. This is the key
      // discriminator (test #3): a genuine owner-wide reconciliation gap (the
      // legacy null-kind payout) stays an AUTHORITATIVE balanced:false — the scope
      // flag does NOT suppress it, because the scope is complete here.
      scopeIncompleteForSettlements: false,
    });
  });

  // ── Cycle 9: deposit-inclusive collections — the R15 identity must account for
  // a period deposit (folded into closingPayableC by resolveOwnerBalance) ───────
  it("[Cycle9] a security deposit collected in-month is included in collectionsC so the R15 identity still balances on healthy data", async () => {
    const res = await makeApp(ownerSession(OWNER_DEPOSIT)).request(`/owner-live/reconciliation?month=${MONTH_M}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_DEPOSIT,
      apartmentId: null,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      // 1000.00 rent income + 500.00 deposit collected this month = 1500.00.
      collectionsC: 150000,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 0,
      reversalsC: 0,
      // carriedForward = ledger(100000) + periodDeposit(50000) = 150000.
      closingPayableC: 150000,
      // With the deposit folded into collections, LHS == closing → balanced.
      balanced: true,
      discrepancyC: 0,
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 150000,
      scopeIncompleteForSettlements: false, // owner-wide request → always false
    });
  });

  // ── Cycle 10: per-unit request whose settlement IS attributable to that unit →
  // flag false (precision guard — NOT the lazy "apartmentId != null") ───────────
  it("[Cycle10] a per-unit request whose only settlement belongs to that apartment keeps scopeIncompleteForSettlements=false and balanced=true (flag is precise, not just 'apartmentId set')", async () => {
    const res = await makeApp(ownerSession(OWNER_ATTRIB)).request(
      `/owner-live/reconciliation?month=${MONTH_M}&apartmentId=${APT_ATTRIB}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      ownerPartyId: OWNER_ATTRIB,
      apartmentId: APT_ATTRIB,
      periodMonth: MONTH_M,
      openingPayableC: 0,
      collectionsC: 80000,
      offsetDeductionsC: 0,
      passThroughExpensesC: 0,
      grossRemittancesC: 30000, // this apartment's OWN per-unit remittance
      reversalsC: 0,
      // unit-scoped closing DOES see this apartment's own payout: 80000 − 30000.
      closingPayableC: 50000,
      balanced: true,
      discrepancyC: 0,
      periodStatus: "open",
      frozenNetPayableAtCloseC: null,
      remainingPayableNowC: 50000,
      // The settlement's apartmentId == the requested apartment → fully
      // attributable → scope is COMPLETE for this per-unit view → false.
      scopeIncompleteForSettlements: false,
    });
  });
});
