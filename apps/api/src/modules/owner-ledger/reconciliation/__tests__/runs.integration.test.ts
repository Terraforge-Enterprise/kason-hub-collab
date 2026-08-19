/**
 * runs.integration.test.ts — R8 reconciliation run orchestration (runReconciliation).
 *
 * Wraps the two check functions (runSourceToLedger / runFrozenIntegrity) in a durable
 * OwnerLedgerReconciliationRun: opens `running`, invokes the check(s), tallies counts,
 * marks `completed`; on a THROWN check marks THAT run `failed` + failureInfo WITHOUT
 * aborting the sweep (the other type still runs — per-type isolation, spec Error
 * Handling R5/R6). Runs INDEPENDENT of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (R10).
 *
 * The two checks are mocked to DELEGATE to their real implementations by default (so
 * A1/A3 exercise the genuine wiring), and per-test overrides inject a fixed count (A2)
 * or a rejection (A5) — this isolates the ORCHESTRATOR's contract from the checks' own
 * (separately-tested) internals.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/runs.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";

vi.mock("../source-to-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../source-to-ledger")>();
  return { ...actual, runSourceToLedger: vi.fn(actual.runSourceToLedger) };
});
vi.mock("../frozen-integrity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../frozen-integrity")>();
  return { ...actual, runFrozenIntegrity: vi.fn(actual.runFrozenIntegrity) };
});

import { runReconciliation } from "../runs";
import { runSourceToLedger } from "../source-to-ledger";
import { runFrozenIntegrity } from "../frozen-integrity";
import type { OwnerLedgerActorCtx } from "../../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 4c10; unused by any other suite) ───────────────
const ORG = "4c100000-0000-4000-8000-000000000001";
const USER = "4c100000-0000-4000-8000-000000000002";
const OWNER = "4c100000-0000-4000-8000-000000000003";

const ctx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

const runsFor = (type?: string) =>
  getDb().ownerLedgerReconciliationRun.findMany({
    where: { organizationId: ORG, ...(type ? { reconciliationType: type } : {}) },
    orderBy: { startedAt: "asc" },
  });

dn("runReconciliation — reconciliation run orchestration (R8, integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().organization.create({
      data: {
        id: ORG, name: "4C10 Recon Runs Org", slug: "4c10-recon-runs-org", status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });
  });
  afterAll(cleanup);
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().ownerLedgerReconciliationRun.deleteMany({ where: { organizationId: ORG } });
    await getDb().ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  });

  // ── A1: a single-type run opens→completes one durable run row ────────────────────
  it("A1: reconciliationType=source_to_ledger creates one `completed` full-scope run with trigger metadata", async () => {
    const { runIds } = await runReconciliation(ctx, {
      reconciliationType: "source_to_ledger",
      triggerType: "manual",
      triggeredById: USER,
    });

    expect(runIds).toHaveLength(1);
    const rows = await runsFor();
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    expect(run.id).toBe(runIds[0]);
    expect(run.reconciliationType).toBe("source_to_ledger");
    expect(run.status).toBe("completed");
    expect(run.isFullScope).toBe(true);
    expect(run.triggerType).toBe("manual");
    expect(run.triggeredById).toBe(USER);
    expect(run.startedAt).toBeTruthy();
    expect(run.completedAt).not.toBeNull();
    expect(run.failureInfo).toBeNull();
    expect(runSourceToLedger).toHaveBeenCalledTimes(1);
  });

  // ── A2: the run row copies the check's tallies (not hardcoded) ───────────────────
  it("A2: the run row copies the check's sourcesScanned/findingsOpened/findingsResolved", async () => {
    vi.mocked(runSourceToLedger).mockResolvedValueOnce({ sourcesScanned: 7, findingsOpened: 3, findingsResolved: 2 });

    const { runIds } = await runReconciliation(ctx, {
      reconciliationType: "source_to_ledger",
      triggerType: "manual",
    });

    const run = await getDb().ownerLedgerReconciliationRun.findUniqueOrThrow({ where: { id: runIds[0] } });
    expect(run.status).toBe("completed");
    expect(run.sourcesScanned).toBe(7);
    expect(run.findingsOpened).toBe(3);
    expect(run.findingsResolved).toBe(2);
  });

  // ── A3: `both` runs both checks under two run rows ───────────────────────────────
  it("A3: reconciliationType=both creates two completed runs (source_to_ledger + frozen_integrity)", async () => {
    const { runIds } = await runReconciliation(ctx, { reconciliationType: "both", triggerType: "manual" });

    expect(runIds).toHaveLength(2);
    const rows = await runsFor();
    expect(rows.map((r) => r.reconciliationType).sort()).toEqual(["frozen_integrity", "source_to_ledger"]);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(runSourceToLedger).toHaveBeenCalledTimes(1);
    expect(runFrozenIntegrity).toHaveBeenCalledTimes(1);
  });

  // ── A4: a filtered run is non-full-scope and records the filter ──────────────────
  it("A4: an owner/month filter marks the run non-full-scope and records the filter in scopeJson", async () => {
    const { runIds } = await runReconciliation(ctx, {
      reconciliationType: "source_to_ledger",
      ownerPartyId: OWNER,
      month: "2026-06",
      triggerType: "manual",
    });

    const run = await getDb().ownerLedgerReconciliationRun.findUniqueOrThrow({ where: { id: runIds[0] } });
    expect(run.isFullScope).toBe(false);
    expect(run.scopeJson).toEqual({ ownerPartyId: OWNER, month: "2026-06" });
  });

  // ── A5: a thrown check → THAT run failed; the other type still completes ──────────
  it("A5: a thrown check marks THAT run failed with failureInfo; the other type still completes (per-type isolation)", async () => {
    vi.mocked(runSourceToLedger).mockRejectedValueOnce(new Error("simulated source_to_ledger scan failure"));

    const { runIds } = await runReconciliation(ctx, { reconciliationType: "both", triggerType: "cron" });

    expect(runIds).toHaveLength(2);
    const src = await getDb().ownerLedgerReconciliationRun.findFirstOrThrow({
      where: { organizationId: ORG, reconciliationType: "source_to_ledger" },
    });
    const frz = await getDb().ownerLedgerReconciliationRun.findFirstOrThrow({
      where: { organizationId: ORG, reconciliationType: "frozen_integrity" },
    });
    expect(src.status).toBe("failed");
    expect(src.failureInfo).toContain("simulated source_to_ledger scan failure");
    expect(src.completedAt).not.toBeNull();
    // The other check still ran despite the first throwing — the sweep was not aborted.
    expect(frz.status).toBe("completed");
  });
});
