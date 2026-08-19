/**
 * Recurring-charges migration (20260720120000) — structural verification.
 *
 * Confirms the 3 new tables + `Charge.sourceRecurringLineId` exist and are all-additive,
 * and that the DB-enforced unique constraints hold. The revision NON-OVERLAP invariant is
 * SERVICE-enforced (recurring.service.ts), not a DB exclusion constraint, so it is proven
 * in the Task-3 sync integration test, not here.
 *
 * Real local Postgres only.
 * Run: from repo root
 *   set -a; . ./.env; set +a; RUN_INTEGRATION=1 npx vitest run packages/db/__tests__/recurring-charges.migration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, Prisma } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c1000000-0000-4000-8000-000000000001";
const APT = "c1000000-0000-4000-8000-000000000002";
const USER = "c1000000-0000-4000-8000-000000000003";
const D1 = "c1000000-0000-4000-8000-000000000010";
const month = (m: number) => new Date(Date.UTC(2026, m - 1, 1));

async function cleanup() {
  const db = getDb();
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
}

dn("recurring-charges migration (structure + unique constraints)", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("the 3 new tables + Charge.sourceRecurringLineId column exist (all-additive)", async () => {
    const db = getDb();
    const tables = await db.$queryRaw<Array<{ table_name: string }>>(Prisma.sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('RecurringChargeDefinition', 'RecurringChargeRevision', 'GridEntryRecurringLine')`);
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "GridEntryRecurringLine",
      "RecurringChargeDefinition",
      "RecurringChargeRevision",
    ]);
    const col = await db.$queryRaw<Array<{ c: number }>>(Prisma.sql`
      SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'Charge' AND column_name = 'sourceRecurringLineId'`);
    expect(col[0].c).toBe(1);
  });

  it("a definition + two ADJACENT revisions persist (org/apt are plain columns — no FK fixture)", async () => {
    const db = getDb();
    const def = await db.recurringChargeDefinition.create({
      data: { id: D1, organizationId: ORG, apartmentId: APT, kind: "CUSTOM", code: "custom-service", name: "Service fee", createdBy: USER },
    });
    await db.recurringChargeRevision.create({
      data: { definitionId: def.id, amount: "100.00", bearer: "tenant", effectiveFromMonth: month(1), effectiveToMonth: month(10), enabled: true, createdBy: USER },
    });
    await db.recurringChargeRevision.create({
      data: { definitionId: def.id, amount: "120.00", bearer: "tenant", effectiveFromMonth: month(10), effectiveToMonth: null, enabled: true, createdBy: USER },
    });
    const revs = await db.recurringChargeRevision.findMany({ where: { definitionId: def.id }, orderBy: { effectiveFromMonth: "asc" }, select: { amount: true, effectiveFromMonth: true } });
    expect(revs).toHaveLength(2);
    expect(Number(revs[0].amount)).toBe(100);
    expect(Number(revs[1].amount)).toBe(120);
  });

  it("the (organizationId, apartmentId, code) unique rejects a duplicate definition code", async () => {
    const db = getDb();
    await expect(
      db.recurringChargeDefinition.create({
        data: { organizationId: ORG, apartmentId: APT, kind: "CUSTOM", code: "custom-service", name: "Dup", createdBy: USER },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
