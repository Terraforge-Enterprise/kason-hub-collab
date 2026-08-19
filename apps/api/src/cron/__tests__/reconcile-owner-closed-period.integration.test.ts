/**
 * runReconcileOwnerClosedPeriodCron — nightly owner closed-period reconciliation cron (R8).
 * Integration test against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * BEHAVIOR INVENTORY (RED before the cron exists → GREEN after):
 *   - C1: per org with a system actor, runs a FULL-SCOPE run of BOTH checks under the
 *     `cron` trigger → two OwnerLedgerReconciliationRun rows (source_to_ledger +
 *     frozen_integrity), full scope, triggerType "cron", completed; returns a summary.
 *   - C2: per-ORG isolation — an org whose resolveSystemActor THROWS is counted `skipped`
 *     and NEVER aborts the sweep; other orgs still reconcile (mirrors the freeze cron).
 *
 * Runs INDEPENDENT of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (spec R10): NO flag guard —
 * the preflight must have fresh runs BEFORE the flag is enabled. This suite leaves the flag
 * UNSET and the cron still produces runs.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/cron/__tests__/reconcile-owner-closed-period.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";

// A whole ORG whose resolveSystemActor throws — proves per-ORG try/catch isolation.
const BAD_ORG = "4e100000-0000-4000-8000-000000000009";

vi.mock("../../modules/billing/auto-draft.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/billing/auto-draft.repository")>();
  return {
    ...actual,
    resolveSystemActor: vi.fn(async (orgId: string) => {
      if (orgId === BAD_ORG) throw new Error("simulated org-level failure (BAD_ORG resolveSystemActor)");
      return actual.resolveSystemActor(orgId);
    }),
  };
});

import { runReconcileOwnerClosedPeriodCron } from "../reconcile-owner-closed-period";
import { resolveSystemActor } from "../../modules/billing/auto-draft.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 4e10; unused by any other suite) ───────────────
const ORG = "4e100000-0000-4000-8000-000000000001";
const ADMIN = "4e100000-0000-4000-8000-000000000002";

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.organization.deleteMany({ where: { id: BAD_ORG } });
}

let savedLedger: string | undefined;

dn("runReconcileOwnerClosedPeriodCron (integration)", () => {
  beforeAll(async () => {
    savedLedger = process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER; // R10: flag-independent
    await cleanup();
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG, name: "4E10 Recon Cron Org", slug: "4e10-recon-cron-org", status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    await db.user.create({
      data: { id: ADMIN, organizationId: ORG, email: "4e10-admin@test.local", fullName: "4E10 Admin", status: "active", role: "admin" },
    });
  });
  afterAll(async () => {
    if (savedLedger === undefined) delete process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER;
    else process.env.ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER = savedLedger;
    await cleanup();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
    await getDb().organization.deleteMany({ where: { id: BAD_ORG } });
  });

  // ── C1: a full-scope BOTH-checks `cron` run per org ─────────────────────────────
  it("C1: runs a full-scope BOTH-checks reconciliation per org as a `cron` trigger and returns a summary", async () => {
    const summary = await runReconcileOwnerClosedPeriodCron();

    expect(summary.ranOrgs).toBeGreaterThanOrEqual(1);
    expect(summary.runsCompleted).toBeGreaterThanOrEqual(2);

    const runs = await getDb().ownerLedgerReconciliationRun.findMany({ where: { organizationId: ORG } });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.reconciliationType).sort()).toEqual(["frozen_integrity", "source_to_ledger"]);
    expect(runs.every((r) => r.triggerType === "cron")).toBe(true);
    expect(runs.every((r) => r.isFullScope)).toBe(true);
    expect(runs.every((r) => r.triggeredById === ADMIN)).toBe(true);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
  });

  // ── C2: per-ORG isolation — a throwing org is skipped, the rest still reconcile ──
  it("C2: an org whose resolveSystemActor throws is skipped; the good org still reconciles", async () => {
    await getDb().organization.create({
      data: {
        id: BAD_ORG, name: "4E10 Bad Org", slug: "4e10-bad-org", status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
    try {
      const summary = await runReconcileOwnerClosedPeriodCron();

      // The good org still produced its two runs despite the bad org throwing.
      const runs = await getDb().ownerLedgerReconciliationRun.findMany({ where: { organizationId: ORG } });
      expect(runs).toHaveLength(2);
      expect(summary.skipped).toBeGreaterThanOrEqual(1);
      // Proof the cron reached (and continued past) the failing org.
      const attemptedBad = vi.mocked(resolveSystemActor).mock.calls.some(([orgId]) => orgId === BAD_ORG);
      expect(attemptedBad).toBe(true);
    } finally {
      await getDb().organization.deleteMany({ where: { id: BAD_ORG } });
    }
  });
});
