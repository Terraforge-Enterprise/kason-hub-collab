/**
 * findings-repo.integration.test.ts — R8 durable reconciliation finding persistence.
 *
 * Idempotent upsert on the dedupe UNIQUE (org, checkKind, sourceType, sourceId,
 * findingType); lastDetectedAt bump on re-detect; auto-resolve of open/acknowledged
 * findings NOT re-emitted by a run; NEVER touches `ignored` findings. These are the
 * money-safety lifecycle rules the two reconciliation checks depend on.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-ledger/reconciliation/__tests__/findings-repo.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { upsertFinding, autoResolveStale, findingKey, type FindingUpsertInput } from "../findings-repo";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix fd10; unused by any other suite) ───────────────
const ORG = "fd100000-0000-4000-8000-000000000001";
const OWNER = "fd100000-0000-4000-8000-000000000002";
const OWNER2 = "fd100000-0000-4000-8000-000000000003";
const SRC_A = "fd100000-0000-4000-8000-0000000000a1";
const SRC_B = "fd100000-0000-4000-8000-0000000000a2";

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

function input(overrides: Partial<FindingUpsertInput> = {}): FindingUpsertInput {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    checkKind: "source_to_ledger",
    findingType: "missing_ledger_row",
    sourceType: "rent",
    sourceId: SRC_A,
    severity: "critical",
    ...overrides,
  };
}

const findByKey = (o: { checkKind?: string; sourceType: string; sourceId: string; findingType: string }) =>
  getDb().ownerLedgerReconciliationFinding.findFirst({
    where: {
      organizationId: ORG,
      checkKind: o.checkKind ?? "source_to_ledger",
      sourceType: o.sourceType,
      sourceId: o.sourceId,
      findingType: o.findingType,
    },
  });

dn("findings-repo — durable reconciliation finding persistence (R8, integration)", () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().organization.create({
      data: {
        id: ORG,
        name: "FD10 Findings Repo Org",
        slug: "fd10-findings-repo-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
  });
  beforeEach(async () => {
    await getDb().ownerLedgerReconciliationFinding.deleteMany({ where: { organizationId: ORG } });
  });
  afterAll(cleanup);

  // ── FR1: a new finding is created open ──────────────────────────────────────────
  it("FR1: upsertFinding creates a new `open` finding with first/lastDetectedAt set", async () => {
    const res = await upsertFinding(
      input({ expectedAmountC: 80000, actualAmountC: 0, expectedDirection: "income" }),
    );
    expect(res.opened).toBe(true);
    expect(res.id).toBeTruthy();

    const row = await findByKey({ sourceType: "rent", sourceId: SRC_A, findingType: "missing_ledger_row" });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("open");
    expect(row!.severity).toBe("critical");
    expect(row!.expectedAmountC).toBe(80000);
    expect(row!.actualAmountC).toBe(0);
    expect(row!.expectedDirection).toBe("income");
    expect(row!.firstDetectedAt).toBeTruthy();
    expect(row!.lastDetectedAt).toBeTruthy();
    expect(row!.resolvedAt).toBeNull();
  });

  // ── FR2: re-detect bumps lastDetectedAt, never duplicates ────────────────────────
  it("FR2: re-upserting the same key bumps lastDetectedAt, keeps one row + original firstDetectedAt", async () => {
    const db = getDb();
    const first = await upsertFinding(input({ actualAmountC: 0 }));
    const rowV1 = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: first.id } });
    await new Promise((r) => setTimeout(r, 10));

    const second = await upsertFinding(input({ actualAmountC: 0 }));
    expect(second.opened).toBe(false); // already open → not newly opened
    expect(second.id).toBe(first.id); // SAME row (idempotent on the dedupe key)

    const all = await db.ownerLedgerReconciliationFinding.findMany({
      where: { organizationId: ORG, sourceId: SRC_A, findingType: "missing_ledger_row" },
    });
    expect(all).toHaveLength(1); // never duplicated
    const rowV2 = all[0]!;
    expect(rowV2.lastDetectedAt.getTime()).toBeGreaterThan(rowV1.lastDetectedAt.getTime()); // bumped
    expect(rowV2.firstDetectedAt.getTime()).toBe(rowV1.firstDetectedAt.getTime()); // preserved
    expect(rowV2.status).toBe("open");
  });

  // ── FR3: a RESOLVED finding re-detected reopens (the corruption came back) ────────
  it("FR3: re-upserting a `resolved` finding reopens it (status open, resolvedAt cleared)", async () => {
    const db = getDb();
    const first = await upsertFinding(input());
    await db.ownerLedgerReconciliationFinding.update({
      where: { id: first.id },
      data: { status: "resolved", resolvedAt: new Date(), resolvedById: OWNER2 },
    });

    const again = await upsertFinding(input());
    expect(again.id).toBe(first.id);
    expect(again.opened).toBe(true); // reopened counts as opened

    const row = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe("open");
    expect(row.resolvedAt).toBeNull();
    expect(row.resolvedById).toBeNull();
  });

  // ── FR4: an IGNORED finding is never touched by upsert (no bump, no reopen) ───────
  it("FR4: re-upserting an `ignored` finding leaves it untouched (status, reason, lastDetectedAt)", async () => {
    const db = getDb();
    const first = await upsertFinding(input());
    const frozenLastDetected = new Date(Date.UTC(2020, 0, 1));
    await db.ownerLedgerReconciliationFinding.update({
      where: { id: first.id },
      data: { status: "ignored", reason: "known — owner waived", lastDetectedAt: frozenLastDetected },
    });
    await new Promise((r) => setTimeout(r, 10));

    const again = await upsertFinding(input({ actualAmountC: 999 }));
    expect(again.id).toBe(first.id);
    expect(again.opened).toBe(false);

    const row = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe("ignored"); // never reopened
    expect(row.reason).toBe("known — owner waived");
    expect(row.lastDetectedAt.getTime()).toBe(frozenLastDetected.getTime()); // NOT bumped
    expect(row.actualAmountC).not.toBe(999); // diagnostics NOT refreshed either
  });

  // ── FR5: auto-resolve a finding NOT re-emitted by the run (repaired) ──────────────
  it("FR5: autoResolveStale resolves an `open` finding absent from the emitted set; keeps the re-emitted one open", async () => {
    const db = getDb();
    const stale = await upsertFinding(input({ sourceId: SRC_A }));
    const live = await upsertFinding(input({ sourceId: SRC_B }));

    // The run re-emitted only SRC_B this pass → SRC_A is repaired.
    const resolved = await autoResolveStale({
      organizationId: ORG,
      checkKind: "source_to_ledger",
      emittedKeys: new Set([findingKey({ sourceType: "rent", sourceId: SRC_B, findingType: "missing_ledger_row" })]),
    });
    expect(resolved).toBe(1);

    const a = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: stale.id } });
    expect(a.status).toBe("resolved");
    expect(a.resolvedAt).not.toBeNull();
    const b = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: live.id } });
    expect(b.status).toBe("open"); // re-emitted → untouched
    expect(b.resolvedAt).toBeNull();
  });

  // ── FR6: an ACKNOWLEDGED finding not re-emitted also auto-resolves ────────────────
  it("FR6: autoResolveStale resolves an `acknowledged` finding absent from the emitted set", async () => {
    const db = getDb();
    const ack = await upsertFinding(input({ sourceId: SRC_A }));
    await db.ownerLedgerReconciliationFinding.update({ where: { id: ack.id }, data: { status: "acknowledged" } });

    const resolved = await autoResolveStale({
      organizationId: ORG,
      checkKind: "source_to_ledger",
      emittedKeys: new Set(), // nothing re-emitted
    });
    expect(resolved).toBe(1);
    const row = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: ack.id } });
    expect(row.status).toBe("resolved");
  });

  // ── FR7: an IGNORED finding is NEVER auto-resolved (guard on the exclusion) ───────
  it("FR7: autoResolveStale never resolves an `ignored` finding", async () => {
    const db = getDb();
    const ig = await upsertFinding(input({ sourceId: SRC_A }));
    await db.ownerLedgerReconciliationFinding.update({ where: { id: ig.id }, data: { status: "ignored", reason: "waived" } });

    const resolved = await autoResolveStale({
      organizationId: ORG,
      checkKind: "source_to_ledger",
      emittedKeys: new Set(), // nothing re-emitted → would resolve if in scope
    });
    expect(resolved).toBe(0);
    const row = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: ig.id } });
    expect(row.status).toBe("ignored"); // untouched
  });

  // ── FR8: an ACKNOWLEDGED finding re-detected stays acknowledged (admin triage kept) ─
  it("FR8: re-upserting an `acknowledged` finding bumps lastDetectedAt but never reverts it to open", async () => {
    const db = getDb();
    const first = await upsertFinding(input());
    const old = new Date(Date.UTC(2021, 0, 1));
    await db.ownerLedgerReconciliationFinding.update({ where: { id: first.id }, data: { status: "acknowledged", lastDetectedAt: old } });

    const again = await upsertFinding(input({ actualAmountC: 7 }));
    expect(again.opened).toBe(false); // not newly opened
    const row = await db.ownerLedgerReconciliationFinding.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe("acknowledged"); // triage preserved (never clobbered to open)
    expect(row.lastDetectedAt.getTime()).toBeGreaterThan(old.getTime()); // still bumped
  });

  // ── FR9: concurrent upserts of the same key create exactly one row ────────────────
  it("FR9: two concurrent upserts of the same dedupe key create exactly one row (idempotent under a race)", async () => {
    const db = getDb();
    const [a, b] = await Promise.all([upsertFinding(input()), upsertFinding(input())]);
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    const all = await db.ownerLedgerReconciliationFinding.findMany({
      where: { organizationId: ORG, sourceId: SRC_A, findingType: "missing_ledger_row" },
    });
    expect(all).toHaveLength(1); // never duplicated even when both miss the findFirst
  });
});
