/**
 * Portal owner LIVE transactions + FROZEN statements (Task 8) — OWN-DATA-ONLY.
 *
 * SECURITY-CRITICAL integration test (real LOCAL Postgres, opt-in RUN_INTEGRATION=1).
 * Seeds TWO owners (+ a third in a second org) to prove cross-owner / cross-org
 * isolation. Proves:
 *
 *   AUTH / flag
 *     (a) flag OFF → 404 on ALL four endpoints (no shape leak)
 *     (b) cross-owner  /statements/:id → 404 (owner B on owner A's period id)
 *     (c) cross-org    /statements/:id → 404 (owner C, org 2, on org-1 period)
 *     (d) unknown / malformed id → 404
 *   /transactions (LIVE, cash-basis, current month INCLUDED)
 *     (e) owner A sees own settled rows + balance; CURRENT open month present
 *     (f) unpaid + void rows EXCLUDED (cash-basis = active + paid only)
 *     (g) own-data-only: owner B sees only B's rows (never A's)
 *     (h) scope=unit&apartmentId filters to that single unit
 *   /statements (FROZEN docs only + lazy freeze-on-read)
 *     (i) current open month is NOT listed; frozen months ARE
 *     (j) lazy freeze-on-read: a PAST month with activity but no frozen row is
 *         frozen inline AND PERSISTED; the current month is NEVER frozen
 *     (k) year filter
 *   /statements/:id + /:id/pdf
 *     (l) frozen period → snapshot; open (non-frozen) → 409 STATEMENT_NOT_ISSUED
 *     (m) frozen + pdfKey → signed URL; frozen w/o pdf & open → 409
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/portal/owner/__tests__/portal.owner-statements-v2.integration.test.ts \
 *     --no-coverage
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";
import { portalUserTypeGuard } from "../../portal.middleware";

// Stub the ONE external leaf dep the pdf endpoint touches — the Supabase signed-URL
// call — so /statements/:id/pdf is deterministic without a real bucket. putObject
// stays real (spread) but is never hit here: the lazy-freeze path finds no matching
// owner_statement Invoice, so it skips PDF render/store entirely (pdfKey stays null).
vi.mock("../../../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/storage")>();
  return { ...actual, createSignedDownloadUrl: vi.fn(async () => "https://signed.example/owner-stmt.pdf") };
});

// Conditionally fail the COMBINED-scope freeze (apartmentId null) so one test can exercise
// the portal's combined-freeze-fails → skip-per-unit path. Default OFF → every other test
// uses the REAL freeze (spread `actual`); toggled per-test via `freezeControl`.
const freezeControl = vi.hoisted(() => ({ combinedThrows: false }));
vi.mock("../../../owner-billing/owner-statement-period.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../owner-billing/owner-statement-period.service")>();
  return {
    ...actual,
    freezeStatementPeriod: vi.fn(
      async (
        ctx: Parameters<typeof actual.freezeStatementPeriod>[0],
        scope: Parameters<typeof actual.freezeStatementPeriod>[1],
      ) => {
        if (freezeControl.combinedThrows && !scope.apartmentId) {
          throw new Error("simulated combined freeze failure (portal)");
        }
        return actual.freezeStatementPeriod(ctx, scope);
      },
    ),
  };
});

import { portalOwnerStatementsV2Routes } from "../portal.owner-statements-v2.routes";
import { createSignedDownloadUrl } from "../../../../lib/storage";

const RUN = process.env.RUN_INTEGRATION === "1";

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 8f21… — unique to this suite) ──────────────────
const ORG = "8f210000-0000-4000-8000-000000000001";
const ORG2 = "8f210000-0000-4000-8000-0000000000f2";
const OWNER_A = "8f210000-0000-4000-8000-000000000002";
const OWNER_B = "8f210000-0000-4000-8000-000000000003";
const OWNER_C = "8f210000-0000-4000-8000-0000000000c2"; // org 2
const PROPERTY = "8f210000-0000-4000-8000-000000000004";
const PROPERTY_B = "8f210000-0000-4000-8000-000000000005";
const ACTOR = "8f210000-0000-4000-8000-000000000006";
const APT_A = "8f210000-0000-4000-8000-0000000000a1";
const APT_A2 = "8f210000-0000-4000-8000-0000000000a4";
const APT_B = "8f210000-0000-4000-8000-0000000000b1";
const L_A = "8f210000-0000-4000-8000-0000000000a2";
const L_A2 = "8f210000-0000-4000-8000-0000000000a5";
const L_B = "8f210000-0000-4000-8000-0000000000b2";
// Direct-inserted OwnerStatementPeriod rows (owner A).
const FROZEN_PDF = "8f210000-0000-4000-8000-0000000000d1"; // frozen + pdfKey + snapshot
const FROZEN_NOPDF = "8f210000-0000-4000-8000-0000000000d2"; // frozen, pdfKey=null
const OPEN_PERIOD = "8f210000-0000-4000-8000-0000000000d3"; // status="open"
const UNKNOWN_ID = "8f210000-0000-4000-8000-0000000000ff";

// ── Dynamic months relative to the real wall clock (freeze uses new Date()) ─────
const NOW = new Date();
const CUR_Y = NOW.getUTCFullYear();
const CUR_MO = NOW.getUTCMonth(); // 0-based
function firstOf(y: number, mZero: number): Date {
  return new Date(Date.UTC(y, mZero, 1));
}
function ymOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const CUR_FIRST = firstOf(CUR_Y, CUR_MO);
const P1_FIRST = firstOf(CUR_Y, CUR_MO - 1); // prev month — lazy-freeze target
const P2_FIRST = firstOf(CUR_Y, CUR_MO - 2); // pre-frozen + pdf
const P3_FIRST = firstOf(CUR_Y, CUR_MO - 3); // pre-frozen, no pdf
const P4_FIRST = firstOf(CUR_Y, CUR_MO - 4); // open period
const CUR_M = ymOf(CUR_FIRST);
const P1_M = ymOf(P1_FIRST);
const P2_M = ymOf(P2_FIRST);
const P3_M = ymOf(P3_FIRST);
const P4_M = ymOf(P4_FIRST);

function ownerSession(partyId: string, orgId = ORG): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 8)}`,
    orgId,
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: ORG,
  role: "viewer",
  userType: "agent",
  partyId: "8f210000-0000-4000-8000-0000000000ae",
  iat: 0,
  absoluteExp: 0,
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

async function insertEntry(o: {
  ownerPartyId: string;
  propertyId: string;
  apartmentId: string;
  statementMonth: Date;
  transactionDate: Date;
  amount: string;
  paymentStatus?: string;
  status?: string;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: o.ownerPartyId === OWNER_C ? ORG2 : ORG,
      ownerPartyId: o.ownerPartyId,
      propertyId: o.propertyId,
      apartmentId: o.apartmentId,
      statementMonth: o.statementMonth,
      transactionDate: o.transactionDate,
      direction: "income",
      category: "rental_income",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: o.paymentStatus ?? "paid",
      taxCategory: "not_applicable",
      includeInPayout: true,
      attachmentKeys: [],
      sourceType: "manual",
      status: o.status ?? "active",
      createdById: ACTOR,
      updatedById: ACTOR,
    },
  });
}

async function insertPeriod(o: {
  id: string;
  periodMonth: Date;
  billingMonth: string;
  status: string;
  pdfKey?: string | null;
  snapshotJson?: unknown;
}) {
  return getDb().ownerStatementPeriod.create({
    data: {
      id: o.id,
      organizationId: ORG,
      ownerPartyId: OWNER_A,
      apartmentId: null, // combined scope
      periodMonth: o.periodMonth,
      status: o.status,
      issuedAt: o.status === "frozen" ? new Date() : null,
      openingBalanceC: 0,
      closingBalanceC: 123400,
      netPayoutC: 123400,
      snapshotJson: (o.snapshotJson as never) ?? undefined,
      pdfKey: o.pdfKey ?? null,
      idempotencyKey: `ownerstmt:${OWNER_A}:${o.billingMonth}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

async function cleanup() {
  const db = getDb();
  for (const orgId of [ORG, ORG2]) {
    const org = { organizationId: orgId };
    await db.ownerStatementPeriod.deleteMany({ where: org });
    await db.ownerLedgerEntry.deleteMany({ where: org });
    await db.listing.deleteMany({ where: org });
    await db.apartment.deleteMany({ where: org });
    await db.property.deleteMany({ where: org });
    await db.party.deleteMany({ where: org });
    await db.organization.deleteMany({ where: { id: orgId } });
  }
}

async function seed() {
  const db = getDb();
  for (const [id, name] of [[ORG, "Live Ledger Org"], [ORG2, "Live Ledger Org 2"]] as const) {
    await db.organization.create({
      data: {
        id, name, slug: `live-ledger-${id.slice(-4)}`, status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
  }
  for (const [id, orgId, name] of [
    [OWNER_A, ORG, "Owner A"], [OWNER_B, ORG, "Owner B"], [OWNER_C, ORG2, "Owner C"],
  ] as const) {
    await db.party.create({
      data: { id, organizationId: orgId, displayName: name, partyType: "individual", status: "active" },
    });
  }
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Prop A", propertyCode: "8F21-P1", propertyType: "apartment",
      addressLine1: "1 St", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY_B, organizationId: ORG, name: "Prop B", propertyCode: "8F21-P2", propertyType: "apartment",
      addressLine1: "2 St", city: "KL", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  for (const [id, propertyId, code] of [
    [APT_A, PROPERTY, "A-1"], [APT_A2, PROPERTY, "A-2"], [APT_B, PROPERTY_B, "B-1"],
  ] as const) {
    await db.apartment.create({
      data: { id, organizationId: ORG, propertyId, unitCode: code, listingMode: "WHOLE" },
    });
  }
  for (const [id, apartmentId, owner] of [
    [L_A, APT_A, OWNER_A], [L_A2, APT_A2, OWNER_A], [L_B, APT_B, OWNER_B],
  ] as const) {
    await db.listing.create({
      data: {
        id, organizationId: ORG, apartmentId, listingType: "whole", occupancyStatus: "occupied",
        listingStatus: "active", currency: "MYR", ownerPartyId: owner,
      },
    });
  }

  // ── Owner A ledger — CURRENT month (included in /transactions) ─────────────
  await insertEntry({ ownerPartyId: OWNER_A, propertyId: PROPERTY, apartmentId: APT_A, statementMonth: CUR_FIRST, transactionDate: new Date(Date.UTC(CUR_Y, CUR_MO, 5)), amount: "900.00" });
  await insertEntry({ ownerPartyId: OWNER_A, propertyId: PROPERTY, apartmentId: APT_A, statementMonth: CUR_FIRST, transactionDate: new Date(Date.UTC(CUR_Y, CUR_MO, 6)), amount: "111.00", paymentStatus: "unpaid" });
  await insertEntry({ ownerPartyId: OWNER_A, propertyId: PROPERTY, apartmentId: APT_A, statementMonth: CUR_FIRST, transactionDate: new Date(Date.UTC(CUR_Y, CUR_MO, 7)), amount: "555.00", status: "void" });
  await insertEntry({ ownerPartyId: OWNER_A, propertyId: PROPERTY, apartmentId: APT_A2, statementMonth: CUR_FIRST, transactionDate: new Date(Date.UTC(CUR_Y, CUR_MO, 8)), amount: "300.00" });
  // ── Owner A ledger — PAST month P1 (drives lazy freeze-on-read) ────────────
  await insertEntry({ ownerPartyId: OWNER_A, propertyId: PROPERTY, apartmentId: APT_A, statementMonth: P1_FIRST, transactionDate: new Date(Date.UTC(P1_FIRST.getUTCFullYear(), P1_FIRST.getUTCMonth(), 10)), amount: "800.00" });

  // ── Owner B ledger — CURRENT month (cross-owner isolation) ─────────────────
  await insertEntry({ ownerPartyId: OWNER_B, propertyId: PROPERTY_B, apartmentId: APT_B, statementMonth: CUR_FIRST, transactionDate: new Date(Date.UTC(CUR_Y, CUR_MO, 5)), amount: "700.00" });

  // ── Owner C (org 2) ledger — for completeness of cross-org ─────────────────
  // (No apartment/listing needed for /statements/:id cross-org test.)

  // ── Pre-frozen + open periods (direct inserts, owner A, combined) ──────────
  await insertPeriod({
    id: FROZEN_PDF, periodMonth: P2_FIRST, billingMonth: P2_M, status: "frozen",
    pdfKey: `owner-statement-periods/${OWNER_A}/${P2_M.replace("-", "")}-combined.pdf`,
    snapshotJson: [{ id: "snap-1", date: P2_FIRST.toISOString(), direction: "income", category: "rental_income", description: "seed", amount: "1234.00", paymentStatus: "paid" }],
  });
  await insertPeriod({ id: FROZEN_NOPDF, periodMonth: P3_FIRST, billingMonth: P3_M, status: "frozen", pdfKey: null });
  await insertPeriod({ id: OPEN_PERIOD, periodMonth: P4_FIRST, billingMonth: P4_M, status: "open", pdfKey: null });
}

describe.skipIf(!RUN)("portal owner-live transactions + statements (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = "1";
    vi.mocked(createSignedDownloadUrl).mockClear();
    // Reset any lazy-frozen P1 row between tests so the freeze-on-read test is
    // deterministic (the pre-inserted P2/P3/P4 rows are re-created only in beforeAll).
    await getDb().ownerStatementPeriod.deleteMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST },
    });
  });

  // ── (a) flag OFF → 404 on all four endpoints ─────────────────────────────
  describe("(a) flag OFF → 404 (no shape leak)", () => {
    beforeEach(() => {
      delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    });
    it("GET /transactions → 404", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request("/owner-live/transactions");
      expect(res.status).toBe(404);
    });
    it("GET /statements → 404", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request("/owner-live/statements");
      expect(res.status).toBe(404);
    });
    it("GET /statements/:id → 404", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${FROZEN_PDF}`);
      expect(res.status).toBe(404);
    });
    it("GET /statements/:id/pdf → 404", async () => {
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${FROZEN_PDF}/pdf`);
      expect(res.status).toBe(404);
    });
  });

  // ── userType guard blocks a non-owner ────────────────────────────────────
  it("userType guard blocks an agent → 403", async () => {
    const res = await makeApp(agentSession).request("/owner-live/transactions");
    expect(res.status).toBe(403);
  });

  // ── (b)(c)(d) cross-owner / cross-org / unknown :id → 404 ─────────────────
  it("(b) cross-owner: owner B on owner A's period id → 404 (no existence leak)", async () => {
    const res = await makeApp(ownerSession(OWNER_B)).request(`/owner-live/statements/${FROZEN_PDF}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("not_found");
  });
  it("(b2) cross-owner pdf: owner B on owner A's period pdf → 404", async () => {
    const res = await makeApp(ownerSession(OWNER_B)).request(`/owner-live/statements/${FROZEN_PDF}/pdf`);
    expect(res.status).toBe(404);
    expect(vi.mocked(createSignedDownloadUrl)).not.toHaveBeenCalled();
  });
  it("(c) cross-org: owner C (org 2) on org-1 period id → 404", async () => {
    const res = await makeApp(ownerSession(OWNER_C, ORG2)).request(`/owner-live/statements/${FROZEN_PDF}`);
    expect(res.status).toBe(404);
  });
  it("(d) unknown id → 404; malformed (non-uuid) id → 404 (no 500)", async () => {
    const unknown = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${UNKNOWN_ID}`);
    expect(unknown.status).toBe(404);
    const malformed = await makeApp(ownerSession(OWNER_A)).request("/owner-live/statements/not-a-uuid");
    expect(malformed.status).toBe(404);
  });

  // ── (e)(f) /transactions — own settled rows, current month included, cash-basis ──
  it("(e)(f) owner A: settled rows + balance; CURRENT month included; unpaid/void excluded", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request("/owner-live/transactions");
    expect(res.status).toBe(200);
    const body = await res.json();
    const amounts: string[] = body.data.rows.map((r: { amount: string }) => r.amount);
    // settled rows: 900 (cur, APT_A), 300 (cur, APT_A2), 800 (P1, APT_A)
    expect(amounts).toContain("900.00");
    expect(amounts).toContain("300.00");
    expect(amounts).toContain("800.00");
    // cash-basis: unpaid (111) + void (555) EXCLUDED
    expect(amounts).not.toContain("111.00");
    expect(amounts).not.toContain("555.00");
    // own-data-only: never owner B's 700
    expect(amounts).not.toContain("700.00");
    // CURRENT open month present.
    const months: string[] = body.data.rows.map((r: { statementMonth: string }) => r.statementMonth);
    expect(months).toContain(CUR_M);
    // balance object present.
    expect(body.data.balance).toHaveProperty("carriedForward");
    expect(body.data.balance).toHaveProperty("netThisPeriod");
  });

  // ── (h) scope=unit filters to a single unit ───────────────────────────────
  it("(h) scope=unit&apartmentId=APT_A returns only that unit's rows", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/transactions?scope=unit&apartmentId=${APT_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const amounts: string[] = body.data.rows.map((r: { amount: string }) => r.amount);
    expect(amounts).toContain("900.00"); // APT_A current
    expect(amounts).toContain("800.00"); // APT_A P1
    expect(amounts).not.toContain("300.00"); // APT_A2 excluded
    expect(body.data.rows.every((r: { apartmentId: string }) => r.apartmentId === APT_A)).toBe(true);
  });

  // ── (n) graceful-degrade from/to — garbage → unfiltered (no 500); valid → filters ──
  it("(n) from=garbage → 200 unfiltered (no 500); valid from=YYYY-MM filters lower bound", async () => {
    // A malformed `from` must NOT 500 — it degrades to NO lower-bound filter
    // (same philosophy as year's regex-guard), never a Postgres/Invalid-Date crash.
    const garbage = await makeApp(ownerSession(OWNER_A)).request("/owner-live/transactions?from=garbage");
    expect(garbage.status).toBe(200);
    const gb = await garbage.json();
    const gAmounts: string[] = gb.data.rows.map((r: { amount: string }) => r.amount);
    // Unfiltered lower bound → the PAST-month P1 row (800) is still present.
    expect(gAmounts).toContain("800.00");
    expect(gAmounts).toContain("900.00");
    // own-data scoping is independent of from/to → never owner B's 700.
    expect(gAmounts).not.toContain("700.00");

    // A malformed `to` likewise degrades to NO upper-bound filter (no 500).
    const garbageTo = await makeApp(ownerSession(OWNER_A)).request("/owner-live/transactions?to=garbage");
    expect(garbageTo.status).toBe(200);

    // A VALID from=CUR_M still filters: rows before the current month (P1's 800) drop out.
    const filtered = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/transactions?from=${CUR_M}`);
    expect(filtered.status).toBe(200);
    const fb = await filtered.json();
    const fAmounts: string[] = fb.data.rows.map((r: { amount: string }) => r.amount);
    expect(fAmounts).toContain("900.00"); // current month kept
    expect(fAmounts).toContain("300.00"); // current month kept (APT_A2)
    expect(fAmounts).not.toContain("800.00"); // P1 excluded by the lower bound
  });

  // ── (g) own-data-only: owner B sees only B's rows ─────────────────────────
  it("(g) owner B /transactions sees only B's rows (never A's)", async () => {
    const res = await makeApp(ownerSession(OWNER_B)).request("/owner-live/transactions");
    expect(res.status).toBe(200);
    const body = await res.json();
    const amounts: string[] = body.data.rows.map((r: { amount: string }) => r.amount);
    expect(amounts).toContain("700.00");
    expect(amounts).not.toContain("900.00");
    expect(amounts).not.toContain("800.00");
    expect(amounts).not.toContain("300.00");
  });

  // ── (i)(j) /statements — frozen only; current excluded; lazy freeze past ──
  it("(i)(j) lazy-freezes a PAST month + persists; current month NOT frozen / NOT listed", async () => {
    // Precondition: no frozen P1 row (cleared in beforeEach).
    const before = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, status: "frozen" },
    });
    expect(before).toBeNull();

    const res = await makeApp(ownerSession(OWNER_A)).request("/owner-live/statements");
    expect(res.status).toBe(200);
    const body = await res.json();
    const months: string[] = body.data.items.map((p: { month: string }) => p.month);

    // Frozen months listed: P1 (lazy-frozen), P2, P3 (pre-frozen).
    expect(months).toContain(P1_M);
    expect(months).toContain(P2_M);
    expect(months).toContain(P3_M);
    // Open month P4 is NOT listed (frozen-only surface).
    expect(months).not.toContain(P4_M);
    // CURRENT open month is NEVER listed.
    expect(months).not.toContain(CUR_M);

    // Lazy freeze PERSISTED: a frozen P1 row now exists in the DB.
    const p1 = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, status: "frozen" },
    });
    expect(p1).not.toBeNull();

    // The CURRENT month was NEVER frozen (freezeStatementPeriod throws for it).
    const cur = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: CUR_FIRST },
    });
    expect(cur).toBeNull();
  });

  // ── (o) per-unit lazy freeze also freezes the COMBINED sibling (no orphan) ──
  it("(o) a PER-UNIT statements read lazy-freezes the COMBINED sibling too (no orphan)", async () => {
    // Precondition: no P1 periods at all for owner A (cleared in beforeEach).
    const before = await getDb().ownerStatementPeriod.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST },
    });
    expect(before).toHaveLength(0);

    // Read the PER-UNIT surface for APT_A → lazy-freezes the per-unit P1 period.
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements?scope=unit&apartmentId=${APT_A}`);
    expect(res.status).toBe(200);

    // The per-unit P1 period is frozen (the read's direct target).
    const perUnit = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, apartmentId: APT_A, status: "frozen" },
    });
    expect(perUnit).not.toBeNull();

    // INVARIANT (the fix): the COMBINED sibling (apartmentId null) for the same owner-month
    // is ALSO frozen — never a per-unit frozen without its combined sibling. Under the old
    // code only the per-unit period was frozen, orphaning it from the combined-scope
    // guard/reconciliation.
    const combined = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, apartmentId: null, status: "frozen" },
    });
    expect(combined).not.toBeNull();
  });

  // ── (p) per-unit read whose COMBINED freeze FAILS must NOT freeze the per-unit ──
  it("(p) a per-unit read whose combined freeze fails leaves the per-unit UNfrozen (no orphan via the portal)", async () => {
    const before = await getDb().ownerStatementPeriod.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST },
    });
    expect(before).toHaveLength(0);

    freezeControl.combinedThrows = true;
    try {
      // The read still succeeds — a lazy-freeze failure is logged + skipped, never a 500.
      const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements?scope=unit&apartmentId=${APT_A}`);
      expect(res.status).toBe(200);

      // Combined freeze threw → NOT frozen.
      const combined = await getDb().ownerStatementPeriod.findFirst({
        where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, apartmentId: null, status: "frozen" },
      });
      expect(combined).toBeNull();
      // INVARIANT: the per-unit freeze (same try, after the combined) was SKIPPED — no orphan.
      // Under the old code the per-unit froze regardless, orphaning it.
      const perUnit = await getDb().ownerStatementPeriod.findFirst({
        where: { organizationId: ORG, ownerPartyId: OWNER_A, periodMonth: P1_FIRST, apartmentId: APT_A, status: "frozen" },
      });
      expect(perUnit).toBeNull();
    } finally {
      freezeControl.combinedThrows = false;
    }
  });

  it("(k) year filter: a year with no frozen periods → empty", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request("/owner-live/statements?year=1999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });

  it("(g2) owner B /statements never returns A's frozen periods", async () => {
    const res = await makeApp(ownerSession(OWNER_B)).request("/owner-live/statements");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids: string[] = body.data.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(FROZEN_PDF);
    expect(ids).not.toContain(FROZEN_NOPDF);
  });

  // ── (l) /statements/:id — snapshot for frozen; 409 for open ───────────────
  it("(l) frozen period → 200 with snapshot; open period → 409 STATEMENT_NOT_ISSUED", async () => {
    const frozen = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${FROZEN_PDF}`);
    expect(frozen.status).toBe(200);
    const fb = await frozen.json();
    expect(fb.data.status).toBe("frozen");
    expect(fb.data.month).toBe(P2_M);
    expect(Array.isArray(fb.data.snapshot)).toBe(true);
    expect(fb.data.snapshot[0].amount).toBe("1234.00");

    const open = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${OPEN_PERIOD}`);
    expect(open.status).toBe(409);
    const ob = await open.json();
    expect(ob.error).toBe("STATEMENT_NOT_ISSUED");
  });

  // ── (m) /statements/:id/pdf — signed URL for frozen+pdf; 409 otherwise ────
  it("(m) frozen+pdfKey → signed URL; frozen w/o pdf → 409; open → 409", async () => {
    const ok = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${FROZEN_PDF}/pdf`);
    expect(ok.status).toBe(200);
    const okb = await ok.json();
    expect(okb.data.url).toBe("https://signed.example/owner-stmt.pdf");
    expect(vi.mocked(createSignedDownloadUrl)).toHaveBeenCalledWith(
      expect.stringContaining(`owner-statement-periods/${OWNER_A}/`),
      expect.objectContaining({ filename: expect.stringContaining(P2_M) }),
    );

    const noPdf = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${FROZEN_NOPDF}/pdf`);
    expect(noPdf.status).toBe(409);
    expect((await noPdf.json()).error).toBe("STATEMENT_NOT_ISSUED");

    const open = await makeApp(ownerSession(OWNER_A)).request(`/owner-live/statements/${OPEN_PERIOD}/pdf`);
    expect(open.status).toBe(409);
  });
});
