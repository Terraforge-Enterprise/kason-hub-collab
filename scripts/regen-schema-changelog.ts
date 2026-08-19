/**
 * regen-schema-changelog.ts
 *
 * Reads every Prisma migration under packages/db/prisma/migrations/, parses
 * its migration.sql via pgsql-parser, and emits docs/schema-changelog.md as
 * a per-feature index of every schema change.
 *
 * The only field a human writes is the feature name, in a sidecar:
 *   packages/db/prisma/migrations/<folder>/feature.md
 *
 * Spec: docs/superpowers/specs/2026-05-04-uat-freeze-and-schema-changelog-design.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface MigrationFacts {
  tablesCreated: string[];
  tablesDropped: string[];
  columnsAdded: Array<{
    table: string;
    column: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
  }>;
  columnsDropped: Array<{ table: string; column: string }>;
  typeChanges: Array<{ table: string; column: string }>;
  indexesCreated: string[];
  indexesDropped: string[];
  foreignKeysAdded: Array<{ table: string; column: string; refTable: string }>;
  destructive: boolean;
  parseError: boolean;
}

const empty = (): MigrationFacts => ({
  tablesCreated: [],
  tablesDropped: [],
  columnsAdded: [],
  columnsDropped: [],
  typeChanges: [],
  indexesCreated: [],
  indexesDropped: [],
  foreignKeysAdded: [],
  destructive: false,
  parseError: false,
});

/**
 * Extract structural facts from a migration's SQL.
 * Synchronous — uses pgsql-parser's parseSync (requires WASM to be loaded first
 * via loadModule(), which is done by the vitest setup file for tests and
 * by the CLI main() before calling this function).
 */
export function extractMigrationFacts(sql: string): MigrationFacts {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parser = require("pgsql-parser");
  const facts = empty();
  // parseSync returns { version, stmts: [{ stmt, stmt_len }] }
  let parsed: { stmts: Array<{ stmt: any }> };
  try {
    parsed = parser.parseSync(sql);
  } catch {
    facts.parseError = true;
    facts.destructive = true; // fail-closed
    return facts;
  }
  for (const wrapper of parsed.stmts ?? []) {
    const stmt = wrapper.stmt;
    if (!stmt) continue;
    walkStmt(stmt, facts);
  }
  facts.destructive =
    facts.tablesDropped.length > 0 ||
    facts.columnsDropped.length > 0 ||
    facts.typeChanges.length > 0 ||
    facts.columnsAdded.some((c) => !c.nullable && !c.hasDefault);
  return facts;
}

function walkStmt(stmt: any, facts: MigrationFacts): void {
  if (stmt.CreateStmt) {
    const name = stmt.CreateStmt.relation?.relname;
    if (name) facts.tablesCreated.push(name);
    return;
  }
  if (stmt.DropStmt) {
    const removeType = stmt.DropStmt.removeType;
    const objects = stmt.DropStmt.objects ?? [];
    if (removeType === "OBJECT_TABLE") {
      for (const obj of objects) {
        const name = lastNameInList(obj);
        if (name) facts.tablesDropped.push(name);
      }
    } else if (removeType === "OBJECT_INDEX") {
      for (const obj of objects) {
        const name = lastNameInList(obj);
        if (name) facts.indexesDropped.push(name);
      }
    }
    return;
  }
  if (stmt.IndexStmt) {
    const name = stmt.IndexStmt.idxname;
    if (name) facts.indexesCreated.push(name);
    return;
  }
  if (stmt.AlterTableStmt) {
    const tableName = stmt.AlterTableStmt.relation?.relname ?? "";
    const cmds = stmt.AlterTableStmt.cmds ?? [];
    for (const c of cmds) {
      const cmd = c.AlterTableCmd;
      if (!cmd) continue;
      switch (cmd.subtype) {
        case "AT_AddColumn": {
          const colDef = cmd.def?.ColumnDef;
          if (!colDef) break;
          const col = colDef.colname ?? "";
          const typeName = (colDef.typeName?.names ?? [])
            .map((n: any) => n.String?.sval ?? n.String?.str ?? "")
            .filter(Boolean)
            .join(".");
          const constraints = colDef.constraints ?? [];
          const hasNotNull = constraints.some(
            (k: any) => k.Constraint?.contype === "CONSTR_NOTNULL"
          );
          const hasDefault = constraints.some(
            (k: any) => k.Constraint?.contype === "CONSTR_DEFAULT"
          );
          facts.columnsAdded.push({
            table: tableName,
            column: col,
            type: typeName || "unknown",
            nullable: !hasNotNull,
            hasDefault,
          });
          break;
        }
        case "AT_DropColumn":
          facts.columnsDropped.push({
            table: tableName,
            column: cmd.name ?? "",
          });
          break;
        case "AT_AlterColumnType":
          facts.typeChanges.push({
            table: tableName,
            column: cmd.name ?? "",
          });
          break;
        case "AT_AddConstraint": {
          const con = cmd.def?.Constraint;
          if (con?.contype === "CONSTR_FOREIGN") {
            const fkCol = (con.fk_attrs ?? [])
              .map((a: any) => a.String?.sval ?? a.String?.str ?? "")
              .join(",");
            const refTable = con.pktable?.relname ?? "";
            facts.foreignKeysAdded.push({
              table: tableName,
              column: fkCol,
              refTable,
            });
          }
          break;
        }
      }
    }
  }
}

function lastNameInList(obj: any): string {
  const items = obj?.List?.items ?? [];
  if (items.length === 0) return "";
  const last = items[items.length - 1];
  return last?.String?.sval ?? last?.String?.str ?? "";
}

// ---------------------------------------------------------------------------
// CLI: read all migrations, emit the changelog.
// ---------------------------------------------------------------------------

interface MigrationEntry {
  folder: string;
  date: string;
  feature: string;
  facts: MigrationFacts;
}

function parseDateFromFolderName(folder: string): string {
  const m = folder.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return "0000-00-00";
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function readFeatureSidecar(folderPath: string): string {
  const sidecar = path.join(folderPath, "feature.md");
  if (!fs.existsSync(sidecar)) return "UNKNOWN — pending review";
  const raw = fs.readFileSync(sidecar, "utf8").trim();
  return raw || "UNKNOWN — pending review";
}

function renderEntry(entry: MigrationEntry): string {
  const f = entry.facts;
  const lines: string[] = [];
  lines.push(`## ${entry.date} — ${entry.feature}`);
  lines.push("");
  lines.push(`**Migration:** \`${entry.folder}\``);
  lines.push(`**Destructive:** ${f.parseError ? "UNKNOWN (parse error)" : f.destructive ? "yes" : "no"}`);
  if (f.parseError) {
    lines.push(`**Parse error:** SQL could not be parsed by pgsql-parser. Review the migration manually.`);
    lines.push("");
    return lines.join("\n");
  }
  if (f.tablesCreated.length) {
    lines.push(`**Tables created:** ${f.tablesCreated.join(", ")}`);
  }
  if (f.tablesDropped.length) {
    lines.push(`**Tables dropped:** ${f.tablesDropped.join(", ")}`);
  }
  if (f.columnsAdded.length) {
    const cols = f.columnsAdded
      .map((c) => `${c.table}.${c.column} (${c.type}, ${c.nullable ? "nullable" : "not null"}${c.hasDefault ? ", has default" : ""})`)
      .join("; ");
    lines.push(`**Columns added:** ${cols}`);
  }
  if (f.columnsDropped.length) {
    const cols = f.columnsDropped.map((c) => `${c.table}.${c.column}`).join(", ");
    lines.push(`**Columns dropped:** ${cols}`);
  }
  if (f.typeChanges.length) {
    const cols = f.typeChanges.map((c) => `${c.table}.${c.column}`).join(", ");
    lines.push(`**Type changes:** ${cols}`);
  }
  if (f.indexesCreated.length) {
    lines.push(`**Indexes added:** ${f.indexesCreated.join(", ")}`);
  }
  if (f.indexesDropped.length) {
    lines.push(`**Indexes dropped:** ${f.indexesDropped.join(", ")}`);
  }
  if (f.foreignKeysAdded.length) {
    const fks = f.foreignKeysAdded
      .map((fk) => `${fk.table}.${fk.column} → ${fk.refTable}`)
      .join(", ");
    lines.push(`**Foreign keys added:** ${fks}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  // Pre-load the WASM module so parseSync works synchronously throughout
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parser = require("pgsql-parser");
  await parser.loadModule();

  const repoRoot = path.resolve(__dirname, "..");
  const migrationsDir = path.join(repoRoot, "packages/db/prisma/migrations");
  const outFile = path.join(repoRoot, "docs/schema-changelog.md");

  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations dir not found: ${migrationsDir}`);
    process.exit(1);
  }

  const folders = fs
    .readdirSync(migrationsDir)
    .filter((f) => {
      const fp = path.join(migrationsDir, f);
      return fs.statSync(fp).isDirectory();
    })
    .sort()
    .reverse(); // newest first

  const entries: MigrationEntry[] = [];
  for (const folder of folders) {
    const folderPath = path.join(migrationsDir, folder);
    const sqlPath = path.join(folderPath, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue; // e.g. migration_lock.toml-only entries — skip
    const sql = fs.readFileSync(sqlPath, "utf8");
    const facts = extractMigrationFacts(sql);
    if (facts.parseError) {
      console.warn(`[warn] parse failed for ${folder}/migration.sql — review manually`);
    }
    const feature = readFeatureSidecar(folderPath);
    const date = parseDateFromFolderName(folder);
    entries.push({ folder, date, feature, facts });
  }

  const header = [
    "# Schema Changelog",
    "",
    "Auto-generated by `scripts/regen-schema-changelog.ts`. Do not edit by hand —",
    "edit the corresponding `feature.md` sidecar in each migration folder, then",
    "regenerate via `npm run db:regen-changelog --workspace=packages/db`.",
    "",
    "Spec: `docs/superpowers/specs/2026-05-04-uat-freeze-and-schema-changelog-design.md`",
    "",
    "---",
    "",
  ].join("\n");

  const body = entries.map(renderEntry).join("\n");

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, header + body);
  console.log(`Wrote ${outFile} (${entries.length} migrations)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
