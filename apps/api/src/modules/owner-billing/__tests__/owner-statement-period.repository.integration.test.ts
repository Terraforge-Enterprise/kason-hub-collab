/**
 * OwnerStatementPeriod repository (integration — real LOCAL Postgres).
 *
 * Task 3 of the owner-statement live-ledger feature. Proves, against a real
 * localhost Postgres (opt-in RUN_INTEGRATION=1), that:
 *   - findPeriod matches on (org, owner, apartmentId, periodMonth) — hit + miss.
 *   - upsertFrozenPeriod is IDEMPOTENT on (org, idempotencyKey): a second upsert
 *     with the SAME key creates NO duplicate row (the combined-scope composite
 *     unique is NULLs-DISTINCT and does NOT guard this — the idempotencyKey does).
 *   - upsertFrozenPeriod is MONOTONIC: a stale (older/equal) sourceMaxUpdatedAt
 *     never overwrites a newer snapshot; a genuinely newer one does.
 *   - listFrozenPeriodsForOwner filters status="frozen" + scope + year, desc.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/owner-billing/__tests__/owner-statement-period.repository.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getDb, type Prisma, type OwnerStatementPeriod } from "@kason/db";

import {
  upsertFrozenPeriod,
  findPeriod,
  listFrozenPeriodsForOwner,
} from "../owner-statement-period.repository";

// ── Safety guard — never run against a non-local DB ─────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 9c03; unused by any other suite) ───────────────
const ORG = "9c030000-0000-4000-8000-000000000001";
const OWNER = "9c030000-0000-4000-8000-000000000002";
const APT = "9c030000-0000-4000-8000-000000000003";
const OTHER_OWNER = "9c030000-0000-4000-8000-000000000004";

const JUNE = new Date(Date.UTC(2026, 5, 1)); // 2026-06
const MAY = new Date(Date.UTC(2026, 4, 1)); // 2026-05
const JULY = new Date(Date.UTC(2026, 6, 1)); // 2026-07
const LAST_DEC = new Date(Date.UTC(2025, 11, 1)); // 2025-12

async function clearPeriods() {
  await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
}

/**
 * Wrap a TransactionClient so upsertFrozenPeriod's initial findFirst returns a
 * STALE snapshot (simulating a concurrent writer that advanced the row between
 * our read and our write) while every write still hits the REAL DB in the same
 * transaction. Makes the HIGH-2 lost-update race deterministic in one process.
 */
function txWithStaleRead(
  tx: Prisma.TransactionClient,
  staleRow: OwnerStatementPeriod,
): Prisma.TransactionClient {
  const model = new Proxy(tx.ownerStatementPeriod, {
    get(target, prop) {
      if (prop === "findFirst") return async () => staleRow;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "ownerStatementPeriod") return model;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

dn("owner-statement-period.repository (integration)", () => {
  beforeAll(async () => {
    const db = getDb();
    // Fresh org (FK target, ON DELETE CASCADE) — remove any leftover then create.
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await db.organization.create({
      data: {
        id: ORG,
        name: "9C03 Period Repo Org",
        slug: "9c03-period-repo-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearPeriods();
  });

  afterAll(async () => {
    const db = getDb();
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
  });

  // B1 + B2 — find hit / miss
  it("findPeriod returns the matching-scope row (hit) and null for a non-match (miss)", async () => {
    await getDb().$transaction((tx) =>
      upsertFrozenPeriod(tx, ORG, {
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: JUNE,
        status: "frozen",
        openingBalanceC: 0,
        closingBalanceC: 5000,
        netPayoutC: 5000,
        idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
        sourceMaxUpdatedAt: new Date(Date.UTC(2026, 6, 1)),
        issuedAt: new Date(),
      }),
    );

    const hit = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE });
    expect(hit?.closingBalanceC).toBe(5000);
    expect(hit?.apartmentId).toBeNull();

    // Miss: wrong month.
    const missMonth = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: MAY });
    expect(missMonth).toBeNull();
    // Miss: wrong owner.
    const missOwner = await findPeriod(ORG, { ownerPartyId: OTHER_OWNER, apartmentId: null, periodMonth: JUNE });
    expect(missOwner).toBeNull();
    // Miss: per-unit scope when only a combined row exists.
    const missScope = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: APT, periodMonth: JUNE });
    expect(missScope).toBeNull();
  });

  // B3 + B4 — idempotent (no duplicate) + monotonic stale-rejection
  it("upserts idempotently (no duplicate row) and rejects a stale sourceMaxUpdatedAt", async () => {
    const base = {
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: JUNE,
      status: "frozen",
      openingBalanceC: 0,
      closingBalanceC: 5000,
      netPayoutC: 5000,
      idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
      sourceMaxUpdatedAt: new Date(Date.UTC(2026, 6, 1)),
      issuedAt: new Date(),
    };
    const first = await getDb().$transaction((tx) => upsertFrozenPeriod(tx, ORG, base));

    // Stale write (older sourceMaxUpdatedAt, different closing) must NOT overwrite,
    // and must NOT create a second row (idempotencyKey is the real guard —
    // the combined-scope composite unique is NULLs-DISTINCT).
    const second = await getDb().$transaction((tx) =>
      upsertFrozenPeriod(tx, ORG, {
        ...base,
        closingBalanceC: 9999,
        sourceMaxUpdatedAt: new Date(Date.UTC(2026, 5, 20)),
      }),
    );

    // (a) no duplicate — same id, exactly one row for this owner/month.
    expect(second.id).toBe(first.id);
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG, ownerPartyId: OWNER, periodMonth: JUNE },
    });
    expect(count).toBe(1);

    // (b) stale rejected — the newer snapshot's balance survives.
    const row = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE });
    expect(row?.closingBalanceC).toBe(5000);
  });

  // B5 — newer sourceMaxUpdatedAt overwrites
  it("a newer sourceMaxUpdatedAt overwrites the stored snapshot", async () => {
    const base = {
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: JUNE,
      status: "frozen",
      openingBalanceC: 0,
      closingBalanceC: 5000,
      netPayoutC: 5000,
      idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
      sourceMaxUpdatedAt: new Date(Date.UTC(2026, 6, 1)),
      issuedAt: new Date(),
    };
    await getDb().$transaction((tx) => upsertFrozenPeriod(tx, ORG, base));

    // Newer recompute (later sourceMaxUpdatedAt) with a corrected closing balance.
    await getDb().$transaction((tx) =>
      upsertFrozenPeriod(tx, ORG, {
        ...base,
        closingBalanceC: 7200,
        netPayoutC: 7200,
        sourceMaxUpdatedAt: new Date(Date.UTC(2026, 6, 15)),
      }),
    );

    const row = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE });
    expect(row?.closingBalanceC).toBe(7200);
    expect(row?.netPayoutC).toBe(7200);
    // Still exactly one row — an overwrite, not an insert.
    const count = await getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG, ownerPartyId: OWNER, periodMonth: JUNE },
    });
    expect(count).toBe(1);
  });

  // B11 (HIGH-1) — a STALE sourceMaxUpdatedAt handed in as an ISO STRING must be
  // rejected. Pre-fix, the guard did `storedDate >= (data.sourceMaxUpdatedAt as
  // Date)`; with a string RHS, JS coerces via ToNumber → NaN, so the comparison
  // is always false, the guard is silently skipped, and the stale write wins.
  it("rejects a stale sourceMaxUpdatedAt passed as an ISO string (no NaN coercion)", async () => {
    const base = {
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: JUNE,
      status: "frozen",
      openingBalanceC: 0,
      closingBalanceC: 5000,
      netPayoutC: 5000,
      idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
      sourceMaxUpdatedAt: JULY, // stored snapshot: 2026-07-01 (a real Date)
      issuedAt: new Date(),
    };
    await getDb().$transaction((tx) => upsertFrozenPeriod(tx, ORG, base));

    // Stale recompute whose sourceMaxUpdatedAt (2026-05-20) is EARLIER than the
    // stored 2026-07-01, but supplied as an ISO STRING. Must be rejected.
    await getDb().$transaction((tx) =>
      upsertFrozenPeriod(tx, ORG, {
        ...base,
        closingBalanceC: 9999,
        sourceMaxUpdatedAt: "2026-05-20T00:00:00.000Z",
      }),
    );

    const row = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE });
    expect(row?.closingBalanceC).toBe(5000); // stale string rejected — newer snapshot survives
  });

  // B12 (HIGH-2) — the overwrite must be ATOMICALLY guarded. Reproduce the
  // lost-update race: our txn read the row while it was Jun-1/5000, but a
  // concurrent writer has since advanced the real row to Jul-15/7200. Writing an
  // intermediate Jul-2 recompute off the stale read must NOT clobber Jul-15 —
  // the guarded updateMany (WHERE sourceMaxUpdatedAt < incoming) matches 0 rows.
  // Pre-fix (unconditional update WHERE {id}) overwrote it to 6000.
  it("does not overwrite a row a concurrent writer advanced past the incoming timestamp (atomic monotonic guard)", async () => {
    const SRC_JUN1 = new Date(Date.UTC(2026, 5, 1));
    const SRC_JUL15 = new Date(Date.UTC(2026, 6, 15));
    const SRC_JUL2 = new Date(Date.UTC(2026, 6, 2));

    // The row as our txn first read it: Jun-1, closing 5000.
    const staleSnapshot = await getDb().$transaction((tx) =>
      upsertFrozenPeriod(tx, ORG, {
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: JUNE,
        status: "frozen",
        openingBalanceC: 0,
        closingBalanceC: 5000,
        netPayoutC: 5000,
        idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
        sourceMaxUpdatedAt: SRC_JUN1,
        issuedAt: new Date(),
      }),
    );

    // A concurrent writer advances the SAME row to Jul-15 / closing 7200.
    await getDb().ownerStatementPeriod.update({
      where: { id: staleSnapshot.id },
      data: { closingBalanceC: 7200, netPayoutC: 7200, sourceMaxUpdatedAt: SRC_JUL15 },
    });

    // Our txn writes an intermediate Jul-2 recompute using its STALE Jun-1 read.
    await getDb().$transaction((tx) =>
      upsertFrozenPeriod(txWithStaleRead(tx, staleSnapshot), ORG, {
        ownerPartyId: OWNER,
        apartmentId: null,
        periodMonth: JUNE,
        status: "frozen",
        openingBalanceC: 0,
        closingBalanceC: 6000,
        netPayoutC: 6000,
        idempotencyKey: `ownerstmt:${OWNER}:2026-06`,
        sourceMaxUpdatedAt: SRC_JUL2,
        issuedAt: new Date(),
      }),
    );

    const row = await findPeriod(ORG, { ownerPartyId: OWNER, apartmentId: null, periodMonth: JUNE });
    expect(row?.closingBalanceC).toBe(7200); // fresher Jul-15 snapshot survives the stale Jul-2 write
  });

  // B6 + B7 + B8 + B9 — list filters status=frozen + scope + year, ordered desc
  it("listFrozenPeriodsForOwner filters status=frozen + scope + year, ordered periodMonth desc", async () => {
    const db = getDb();
    const src = new Date(Date.UTC(2026, 6, 1));
    async function seed(
      periodMonth: Date,
      apartmentId: string | null,
      status: string,
      key: string,
      closing: number,
    ) {
      await db.ownerStatementPeriod.create({
        data: {
          organizationId: ORG,
          ownerPartyId: OWNER,
          apartmentId,
          periodMonth,
          status,
          openingBalanceC: 0,
          closingBalanceC: closing,
          netPayoutC: closing,
          idempotencyKey: key,
          sourceMaxUpdatedAt: src,
        },
      });
    }
    // Combined frozen: June + May 2026 (in scope for combined + 2026).
    await seed(JUNE, null, "frozen", `ownerstmt:${OWNER}:2026-06`, 5000);
    await seed(MAY, null, "frozen", `ownerstmt:${OWNER}:2026-05`, 4000);
    // Excluded by STATUS: July 2026 combined but still open.
    await seed(JULY, null, "open", `ownerstmt:${OWNER}:2026-07`, 6000);
    // Excluded by SCOPE: June 2026 per-unit (apartmentId set) — not a combined row.
    await seed(JUNE, APT, "frozen", `ownerstmt:${OWNER}:2026-06:${APT}`, 3000);
    // Excluded by YEAR (when year=2026): Dec 2025 combined frozen.
    await seed(LAST_DEC, null, "frozen", `ownerstmt:${OWNER}:2025-12`, 2000);

    // Combined scope (apartmentId null), year 2026 → only June + May, desc.
    const combined2026 = await listFrozenPeriodsForOwner(ORG, OWNER, null, "2026");
    expect(combined2026.map((r) => r.periodMonth.getTime())).toEqual([JUNE.getTime(), MAY.getTime()]);
    expect(combined2026.every((r) => r.status === "frozen")).toBe(true);
    expect(combined2026.every((r) => r.apartmentId === null)).toBe(true);

    // Combined scope, no year filter → all frozen combined across years, desc.
    const combinedAll = await listFrozenPeriodsForOwner(ORG, OWNER, null);
    expect(combinedAll.map((r) => r.periodMonth.getTime())).toEqual([
      JUNE.getTime(),
      MAY.getTime(),
      LAST_DEC.getTime(),
    ]);

    // Per-unit scope (apartmentId APT) → only the per-unit frozen row.
    const perUnit = await listFrozenPeriodsForOwner(ORG, OWNER, APT);
    expect(perUnit).toHaveLength(1);
    expect(perUnit[0]?.apartmentId).toBe(APT);
    expect(perUnit[0]?.periodMonth.getTime()).toBe(JUNE.getTime());
  });
});
