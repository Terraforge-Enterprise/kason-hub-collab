/**
 * Task 1 migration proof — schema-level behavior test for the bills-grid invoice
 * link. A migration isn't naturally TDD-able, so we treat COLUMN/INDEX EXISTENCE
 * as the observable behavior: this suite queries `information_schema.columns` and
 * `pg_indexes` via `prisma.$queryRaw` and asserts the two additive nullable columns
 * + the composite index exist.
 *
 *   - RED:   run BEFORE `prisma migrate deploy` — columns/index absent → fails.
 *   - GREEN: run AFTER `migrate deploy` + `prisma generate` — present → passes.
 *
 * Mirrors the harness convention of the other bills-grid integration suites
 * (RUN_INTEGRATION gate + non-local host guard + getDb()). No fixtures are minted
 * — this reads the catalog only, so it is read-only and touches no rows.
 *
 * Run:
 *   cd apps/api && set -a; . ../../.env; set +a; RUN_INTEGRATION=1 \
 *     npx vitest run src/modules/bills-grid/__tests__/migration-fields.integration.test.ts
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const prisma = getDb();

type ColumnRow = { data_type: string; is_nullable: string };
type IndexRow = { indexdef: string };
type FkRow = { conname: string; confdeltype: string; reftable: string };

async function column(table: string, col: string): Promise<ColumnRow | undefined> {
  const rows = await prisma.$queryRaw<ColumnRow[]>`
    SELECT data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${col}
  `;
  return rows[0];
}

d("Task 1 migration: bills-grid invoice link fields", () => {
  it("Charge.sourceGridEntryId exists, is nullable, and is a uuid", async () => {
    const col = await column("Charge", "sourceGridEntryId");
    expect(col, "Charge.sourceGridEntryId column should exist").toBeDefined();
    expect(col?.is_nullable).toBe("YES");
    expect(col?.data_type).toBe("uuid");
  });

  it("UnitBillsGridEntry.invoicedAt exists and is nullable", async () => {
    const col = await column("UnitBillsGridEntry", "invoicedAt");
    expect(col, "UnitBillsGridEntry.invoicedAt column should exist").toBeDefined();
    expect(col?.is_nullable).toBe("YES");
    expect(col?.data_type).toContain("timestamp");
  });

  it("Charge has a composite index on (organizationId, sourceGridEntryId)", async () => {
    const rows = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'Charge'
    `;
    const match = rows.find(
      (r) =>
        /"?organizationId"?/.test(r.indexdef) && /"?sourceGridEntryId"?/.test(r.indexdef),
    );
    expect(
      match,
      "an index covering (organizationId, sourceGridEntryId) should exist on Charge",
    ).toBeDefined();
  });

  it("Charge.sourceGridEntryId is a FK to UnitBillsGridEntry with ON DELETE SET NULL", async () => {
    // pg_constraint: contype='f' (foreign key). confdeltype='n' = SET NULL on delete.
    // The FK must be on Charge.sourceGridEntryId and reference UnitBillsGridEntry(id) so
    // that deleting a grid entry nulls the ref (never orphans it), per the brief's mandate.
    const rows = await prisma.$queryRaw<FkRow[]>`
      SELECT c.conname, c.confdeltype::text AS confdeltype, cf.relname AS reftable
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class cf ON cf.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
        AND cl.relname = 'Charge'
        AND c.conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = cl.oid AND attname = 'sourceGridEntryId')
        ]::smallint[]
    `;
    const fk = rows[0];
    expect(
      fk,
      "a FK on Charge.sourceGridEntryId should exist",
    ).toBeDefined();
    expect(
      fk?.reftable,
      "the FK should reference UnitBillsGridEntry",
    ).toBe("UnitBillsGridEntry");
    expect(
      fk?.confdeltype,
      "the FK on-delete action should be SET NULL (confdeltype='n')",
    ).toBe("n");
  });
});
