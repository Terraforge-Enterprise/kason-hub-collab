/**
 * reconciliation.routes.integration.test.ts — R8 admin reconciliation endpoints.
 *
 * POST /reconciliation-runs (trigger), GET /reconciliation-runs (history),
 * GET /reconciliation-findings (page), POST /reconciliation-findings/:id/acknowledge,
 * POST /reconciliation-findings/:id/ignore (reason REQUIRED). All requireRole("admin").
 *
 * MOUNT / R10: these endpoints run INDEPENDENT of the phase-2 owner-billing / live-ledger
 * flags — this whole suite leaves ENABLE_PHASE2_OWNER_BILLING and
 * ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER UNSET and the endpoints still work. B9 proves
 * the distinct mount prefix (/api/owner-ledger-reconciliation) escapes the real
 * ownerLedgerFlagGate that 404s /api/owner-ledger/* while the flag is dark.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/reconciliation.routes.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../../lib/auth";
import { reconciliationRoutes } from "../reconciliation.routes";
import { ownerLedgerFlagGate } from "../../owner-ledger.gate";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 4d10; unused by any other suite) ───────────────
const ORG = "4d100000-0000-4000-8000-000000000001";
const USER = "4d100000-0000-4000-8000-000000000002";
const OWNER = "4d100000-0000-4000-8000-000000000003";
const SRC = "4d100000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "4d100000-0000-4000-8000-0000000000c1";
const OTHER_ORG_FINDING_SRC = "4d100000-0000-4000-8000-0000000000b1";

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

async function seedFinding(overrides: Record<string, unknown> = {}) {
  return getDb().ownerLedgerReconciliationFinding.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      checkKind: "source_to_ledger",
      findingType: "missing_ledger_row",
      sourceType: "rent",
      sourceId: SRC,
      severity: "critical",
      status: "open",
      lastDetectedAt: new Date(),
      ...overrides,
    },
  });
}

async function seedRun(o: { type: string; status: string; startedAt?: Date }) {
  return getDb().ownerLedgerReconciliationRun.create({
    data: {
      organizationId: ORG,
      reconciliationType: o.type,
      isFullScope: true,
      status: o.status,
      triggerType: "manual",
      ...(o.startedAt ? { startedAt: o.startedAt } : {}),
    },
  });
}

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

let savedBilling: string | undefined;
let savedLedger: string | undefined;

dn("reconciliation admin endpoints (R8, integration)", () => {
  beforeAll(async () => {
    // R10: prove the endpoints run with BOTH phase-2 flags UNSET.
    savedBilling = process.env.ENABLE_PHASE2_OWNER_BILLING;
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    await cleanup();
    await getDb().organization.create({
      data: {
        id: ORG, name: "4D10 Recon Routes Org", slug: "4d10-recon-routes-org", status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
  });
  afterAll(async () => {
    if (savedBilling === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    else process.env.ENABLE_PHASE2_OWNER_BILLING = savedBilling;
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
    await getDb().ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  });

  // ── B1: POST /reconciliation-runs triggers run(s) ────────────────────────────────
  it("B1: POST /reconciliation-runs {both} returns 201 + runIds and persists two completed runs", async () => {
    const res = await makeApp(adminSession).request(`${PREFIX}/reconciliation-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliationType: "both" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.runIds).toHaveLength(2);

    const rows = await getDb().ownerLedgerReconciliationRun.findMany({ where: { organizationId: ORG } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.triggerType === "manual")).toBe(true);
    expect(rows.every((r) => r.triggeredById === USER)).toBe(true);
  });

  // ── B3: GET /reconciliation-runs — history + type/status/limit filters ────────────
  it("B3: GET /reconciliation-runs returns run history filtered by type/status/limit", async () => {
    await seedRun({ type: "source_to_ledger", status: "completed", startedAt: new Date(Date.UTC(2026, 5, 1)) });
    await seedRun({ type: "frozen_integrity", status: "completed", startedAt: new Date(Date.UTC(2026, 5, 2)) });
    await seedRun({ type: "source_to_ledger", status: "failed", startedAt: new Date(Date.UTC(2026, 5, 3)) });

    const app = makeApp(adminSession);
    const all = await (await app.request(`${PREFIX}/reconciliation-runs`)).json();
    expect(all.data).toHaveLength(3);
    // newest first
    expect(all.data[0].status).toBe("failed");

    const byType = await (await app.request(`${PREFIX}/reconciliation-runs?type=source_to_ledger`)).json();
    expect(byType.data).toHaveLength(2);

    const byStatus = await (await app.request(`${PREFIX}/reconciliation-runs?status=failed`)).json();
    expect(byStatus.data).toHaveLength(1);

    const limited = await (await app.request(`${PREFIX}/reconciliation-runs?limit=1`)).json();
    expect(limited.data).toHaveLength(1);
  });

  // ── B4: GET /reconciliation-findings — page + filters ────────────────────────────
  it("B4: GET /reconciliation-findings returns findings filtered by checkKind/status/severity/owner/month", async () => {
    await seedFinding({ sourceId: SRC, checkKind: "source_to_ledger", severity: "critical", status: "open", originalBillingMonth: new Date(Date.UTC(2026, 5, 1)) });
    await seedFinding({ sourceId: "4d100000-0000-4000-8000-0000000000a2", checkKind: "frozen_integrity", findingType: "post_freeze_creation", sourceType: "owner_ledger_entry", severity: "warning", status: "acknowledged", originalBillingMonth: new Date(Date.UTC(2026, 4, 1)) });

    const app = makeApp(adminSession);
    const all = await (await app.request(`${PREFIX}/reconciliation-findings`)).json();
    expect(all.data).toHaveLength(2);

    const byKind = await (await app.request(`${PREFIX}/reconciliation-findings?checkKind=frozen_integrity`)).json();
    expect(byKind.data).toHaveLength(1);
    expect(byKind.data[0].findingType).toBe("post_freeze_creation");

    const bySeverity = await (await app.request(`${PREFIX}/reconciliation-findings?severity=critical`)).json();
    expect(bySeverity.data).toHaveLength(1);

    const byStatus = await (await app.request(`${PREFIX}/reconciliation-findings?status=open`)).json();
    expect(byStatus.data).toHaveLength(1);

    const byOwner = await (await app.request(`${PREFIX}/reconciliation-findings?ownerPartyId=${OWNER}`)).json();
    expect(byOwner.data).toHaveLength(2);

    const byMonth = await (await app.request(`${PREFIX}/reconciliation-findings?month=2026-06`)).json();
    expect(byMonth.data).toHaveLength(1);
  });

  // ── B5: acknowledge → acknowledged ───────────────────────────────────────────────
  it("B5: POST /reconciliation-findings/:id/acknowledge marks the finding acknowledged", async () => {
    const f = await seedFinding();
    const res = await makeApp(adminSession).request(`${PREFIX}/reconciliation-findings/${f.id}/acknowledge`, { method: "POST" });
    expect(res.status).toBe(200);
    const row = await getDb().ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.status).toBe("acknowledged");
  });

  // ── B6: ignore WITHOUT a reason → 400, finding unchanged ─────────────────────────
  it("B6: POST /reconciliation-findings/:id/ignore without a reason returns 400 and leaves the finding open", async () => {
    const f = await seedFinding();
    const res = await makeApp(adminSession).request(`${PREFIX}/reconciliation-findings/${f.id}/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const row = await getDb().ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.status).toBe("open"); // untouched
  });

  // ── B7: ignore WITH a reason → ignored + reason stored ───────────────────────────
  it("B7: POST /reconciliation-findings/:id/ignore with a reason marks it ignored and records the reason", async () => {
    const f = await seedFinding();
    const res = await makeApp(adminSession).request(`${PREFIX}/reconciliation-findings/${f.id}/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "owner waived — known backdated adjustment" }),
    });
    expect(res.status).toBe(200);
    const row = await getDb().ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: f.id } });
    expect(row.status).toBe("ignored");
    expect(row.reason).toBe("owner waived — known backdated adjustment");
  });

  // ── B2: POST with an empty body defaults to both + full scope ────────────────────
  it("B2: POST /reconciliation-runs with no body defaults to both checks, full scope", async () => {
    const res = await makeApp(adminSession).request(`${PREFIX}/reconciliation-runs`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.runIds).toHaveLength(2);
    const rows = await getDb().ownerLedgerReconciliationRun.findMany({ where: { organizationId: ORG } });
    expect(rows.every((r) => r.isFullScope)).toBe(true);
  });

  // ── B8: every endpoint requires an operator admin (401 / 403) ────────────────────
  it("B8: endpoints require admin — 401 without a session, 403 for manager/owner", async () => {
    const paths: Array<[string, RequestInit]> = [
      [`${PREFIX}/reconciliation-runs`, { method: "POST" }],
      [`${PREFIX}/reconciliation-runs`, { method: "GET" }],
      [`${PREFIX}/reconciliation-findings`, { method: "GET" }],
    ];
    for (const [path, init] of paths) {
      expect((await makeApp(null).request(path, init)).status).toBe(401);
      expect((await makeApp(managerSession).request(path, init)).status).toBe(403);
      expect((await makeApp(ownerSession).request(path, init)).status).toBe(403);
    }
    // No run row was ever created by the rejected POSTs.
    expect(await getDb().ownerLedgerReconciliationRun.count({ where: { organizationId: ORG } })).toBe(0);
  });

  // ── B9: R10 — reachable with both phase-2 flags UNSET; the flag-gated prefix 404s ─
  it("B9: reconciliation prefix escapes ownerLedgerFlagGate (reachable flag-dark) while /api/owner-ledger 404s", async () => {
    expect(process.env.ENABLE_PHASE2_OWNER_BILLING).toBeUndefined();
    expect(process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER).toBeUndefined();

    // Faithful replica of app.ts's mount: the REAL ownerLedgerFlagGate on a stand-in
    // router at /api/owner-ledger, and the real reconciliation router at the DISTINCT
    // prefix. Proves Hono binds `use("*")` to the path pattern, so the distinct prefix
    // (which cannot match /api/owner-ledger/*) carries no gate.
    const app = new Hono<{ Variables: { session: SessionPayload } }>();
    app.use("*", async (c, next) => {
      c.set("session", adminSession);
      await next();
    });
    const gated = new Hono<{ Variables: { session: SessionPayload } }>();
    gated.use("*", ownerLedgerFlagGate);
    gated.get("/entries", (c) => c.json({ data: [] }));
    app.route("/api/owner-ledger", gated);
    app.route(PREFIX, reconciliationRoutes);

    // The flag-gated owner-ledger surface 404s while ENABLE_PHASE2_OWNER_BILLING is dark.
    const gatedRes = await app.request("/api/owner-ledger/entries");
    expect(gatedRes.status).toBe(404);

    // The reconciliation surface is reachable (NOT 404) at the distinct prefix.
    const reconRes = await app.request(`${PREFIX}/reconciliation-runs`, { method: "POST" });
    expect(reconRes.status).toBe(201);
  });

  // ── B10: unknown / cross-org finding id → 404 (org-scoped, no cross-tenant mutate) ─
  it("B10: acknowledge/ignore of an unknown or cross-org finding id returns 404 and mutates nothing", async () => {
    const UNKNOWN = "4d100000-0000-4000-8000-0000000000ff";
    const app = makeApp(adminSession);

    expect((await app.request(`${PREFIX}/reconciliation-findings/${UNKNOWN}/acknowledge`, { method: "POST" })).status).toBe(404);
    const ignoreUnknown = await app.request(`${PREFIX}/reconciliation-findings/${UNKNOWN}/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    expect(ignoreUnknown.status).toBe(404);

    // A REAL finding in ANOTHER org must not be reachable by this admin's org-scoped route.
    const db = getDb();
    await db.organization.create({
      data: { id: OTHER_ORG, name: "4D10 Other", slug: "4d10-other-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
    });
    const foreign = await db.ownerLedgerReconciliationFinding.create({
      data: { organizationId: OTHER_ORG, ownerPartyId: OWNER, checkKind: "source_to_ledger", findingType: "missing_ledger_row", sourceType: "rent", sourceId: OTHER_ORG_FINDING_SRC, severity: "critical", status: "open", lastDetectedAt: new Date() },
    });
    try {
      const ackForeign = await app.request(`${PREFIX}/reconciliation-findings/${foreign.id}/acknowledge`, { method: "POST" });
      expect(ackForeign.status).toBe(404);
      const still = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(still.status).toBe("open"); // untouched — cross-tenant isolation held
    } finally {
      await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: OTHER_ORG } });
      await db.organization.deleteMany({ where: { id: OTHER_ORG } });
    }
  });
});
