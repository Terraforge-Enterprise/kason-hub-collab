/**
 * CI lint: every `CREATE TABLE "X"` in a Prisma migration must be paired
 * with `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY` in the same migration —
 * unless the table was created in a migration that ran BEFORE the
 * `20260506000000_rls_lockdown_deny_all` bootstrap, which uses a runtime
 * loop to enable RLS on every existing public-schema table.
 *
 * Spec: docs/superpowers/specs/2026-05-06-supabase-rls-lockdown-design.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Migration {
  name: string;
  sql: string;
}

export interface MissingRls {
  migration: string;
  table: string;
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
const ENABLE_RLS_RE = /ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
// A "sweep" migration enables RLS on every table in `public` via a DO $$ block
// that iterates the catalog. Used by 20260506_rls_lockdown_deny_all and
// 20260520_rls_resweep_for_new_tables — both are full-coverage fixes for any
// table created in any prior migration. Detected by the DO $$ … ENABLE ROW
// LEVEL SECURITY pattern (no per-table ALTER, dynamic via EXECUTE).
const SWEEP_PATTERN = /DO\s+\$\$[\s\S]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/i;
// Also detect DROP TABLE so a table created and later dropped in a SUBSEQUENT
// migration (within the same deploy batch) isn't flagged — it would no longer
// exist when the sweep runs OR by the time RLS is verified at runtime.
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;

export function stripSqlComments(sql: string): string {
  // Remove /* block comments */ first (may span lines), then -- line comments.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

export function findTablesMissingRls(migrations: Migration[]): MissingRls[] {
  // Sort by name so issues are reported deterministically across CI runs.
  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  const issues: MissingRls[] = [];

  // Identify all sweep migrations and all dropped tables across the timeline.
  // A table is covered if some sweep migration runs AFTER the CREATE TABLE
  // (sweeps re-enable RLS on every public table at their point in time).
  const sweepNames = sorted
    .filter((m) => SWEEP_PATTERN.test(stripSqlComments(m.sql)))
    .map((m) => m.name);
  const droppedAfter: Record<string, string> = {};
  for (const m of sorted) {
    const sql = stripSqlComments(m.sql);
    for (const match of sql.matchAll(DROP_TABLE_RE)) {
      const table = match[1];
      if (!droppedAfter[table]) droppedAfter[table] = m.name;
    }
  }

  for (const m of sorted) {
    const sql = stripSqlComments(m.sql);
    const created = [...sql.matchAll(CREATE_TABLE_RE)].map((x) => x[1]);
    if (created.length === 0) continue;

    const enabled = new Set(
      [...sql.matchAll(ENABLE_RLS_RE)].map((x) => x[1]),
    );

    for (const table of created) {
      if (enabled.has(table)) continue;
      // Covered if a sweep migration runs after this one.
      const coveredBySweep = sweepNames.some((s) => s.localeCompare(m.name) > 0);
      if (coveredBySweep) continue;
      // Covered if the table is dropped in a later migration before any
      // runtime needs to enforce RLS on it.
      const dropMig = droppedAfter[table];
      if (dropMig && dropMig.localeCompare(m.name) > 0) continue;
      issues.push({ migration: m.name, table });
    }
  }

  return issues;
}

function readMigrationsFromDisk(migrationsDir: string): Migration[] {
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const out: Migration[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sqlPath = path.join(migrationsDir, e.name, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    out.push({ name: e.name, sql: fs.readFileSync(sqlPath, "utf8") });
  }
  return out;
}

function main(): void {
  const migrationsDir = path.resolve(
    process.cwd(),
    "packages/db/prisma/migrations",
  );
  if (!fs.existsSync(migrationsDir)) {
    // eslint-disable-next-line no-console
    console.error(`Migrations dir not found: ${migrationsDir}`);
    process.exit(1);
  }
  const migrations = readMigrationsFromDisk(migrationsDir);
  const issues = findTablesMissingRls(migrations);
  if (issues.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[check-new-tables-have-rls] OK — ${migrations.length} migrations scanned, no missing RLS.`,
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.error(
    `[check-new-tables-have-rls] FAIL — ${issues.length} table(s) missing RLS:`,
  );
  for (const i of issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${i.migration}: ${i.table}`);
  }
  // eslint-disable-next-line no-console
  console.error(
    `\nFix: add \`ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;\` to the migration.`,
  );
  process.exit(1);
}

if (require.main === module) {
  main();
}
