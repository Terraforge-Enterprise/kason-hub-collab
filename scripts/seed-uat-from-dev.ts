/**
 * Seed UAT Supabase with org-scoped settings rows that exist in Dev but not UAT.
 *
 * STRICTLY non-destructive:
 *   - Inserts ONLY rows whose natural key does not exist in UAT.
 *   - Never updates existing UAT rows.
 *   - Never deletes anything.
 *
 * Source connection: SUPABASE_DATABASE_URL from root .env  (= dev / personal Supabase)
 * Target connection: parsed from uat.env's `postgresql://...` line
 *
 * Single org per DB:
 *   - dev → "kaen-demo"  (id: dec012dd-95ea-497d-ba34-7d694b83e951)
 *   - uat → "kaen-uat"   (id: 1d233b59-75ad-484d-9730-511b6aa6d056)
 *
 * Tables in dependency order:
 *   1. TaTier                 (independent)
 *   2. AgentLevelThreshold    (independent)
 *   3. AgentTierMapping       (independent)
 *   4. RoomType               (independent)
 *   5. RenovationStage        (independent)
 *   6. SettingsLabel          (independent)
 *   7. RenovationPackage      → splits
 *   8. RenovationPackageSplit (FK packageId)
 *   9. SalesClaimDefault      → splits
 *  10. SalesClaimDefaultSplit (FK defaultId)
 *
 * Wrapped in a single transaction on the target — any error rolls everything back.
 *
 * Usage (from repo root):
 *   npx tsx scripts/seed-uat-from-dev.ts
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, "utf8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function readSourceUrl(): string {
  const env = loadEnvFile(path.join(REPO_ROOT, ".env"));
  const url = env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL missing in .env");
  return url;
}

function readTargetUrl(): string {
  const content = fs.readFileSync(path.join(REPO_ROOT, "uat.env"), "utf8");
  const match = content.match(/postgresql:\/\/[^\s]+/);
  if (!match) throw new Error("postgresql://... line not found in uat.env");
  return match[0];
}

type RowMap = Record<string, unknown>;
type NaturalKey = (row: RowMap) => string;
type FkRemap = (row: RowMap, parentMap: Map<string, string>) => RowMap;

interface TableSpec {
  name: string;
  columns: string[];               // INSERT column list (excluding id, createdAt, updatedAt — we set those fresh)
  naturalKey: NaturalKey;          // returns a stable string from a row's natural key fields
  // Only for FK-bearing tables: re-points the foreign id at the target's id
  fkRemap?: { fkColumn: string; parentTable: string };
  // Timestamp columns to set fresh on insert (only some tables have these)
  timestampCols?: ("createdAt" | "updatedAt")[];
}

const ORG = {
  dev: "dec012dd-95ea-497d-ba34-7d694b83e951",
  uat: "1d233b59-75ad-484d-9730-511b6aa6d056",
};

const TABLES: TableSpec[] = [
  {
    name: "TaTier",
    columns: ["organizationId", "tier", "rentalMin", "rentalMax", "companyMinimum"],
    naturalKey: (r) => `${r.tier}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "AgentLevelThreshold",
    columns: ["organizationId", "agentLevel", "minCumulativeCommission"],
    naturalKey: (r) => `${r.agentLevel}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "AgentTierMapping",
    columns: ["organizationId", "claimType", "agentLevel", "percentage", "isActive"],
    naturalKey: (r) => `${r.claimType}|${r.agentLevel}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "RoomType",
    columns: ["organizationId", "name", "sortOrder", "isActive"],
    naturalKey: (r) => `${r.name}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "RenovationStage",
    columns: ["organizationId", "key", "label", "description", "sortOrder", "archived"],
    naturalKey: (r) => `${r.key}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "SettingsLabel",
    columns: ["organizationId", "category", "key", "label", "sortOrder"],
    naturalKey: (r) => `${r.category}|${r.key}`,
    // No timestamps in schema
  },
  {
    name: "RenovationPackage",
    columns: ["organizationId", "key", "label", "description", "defaultPrice", "archived", "sortOrder"],
    naturalKey: (r) => `${r.key}`,
    timestampCols: ["createdAt", "updatedAt"],
  },
  {
    name: "RenovationPackageSplit",
    columns: ["organizationId", "packageId", "roleLabel", "splitType", "splitValue", "isHouseKeep", "sortOrder"],
    naturalKey: (r) => `${r.packageId}|${r.roleLabel}|${r.sortOrder}`, // parent + role + sortOrder
    fkRemap: { fkColumn: "packageId", parentTable: "RenovationPackage" },
    // No timestamps in schema
  },
  {
    name: "SalesClaimDefault",
    columns: ["organizationId", "appliesTo", "commissionType", "commissionValue", "paymentType", "notes"],
    naturalKey: (r) => `${r.appliesTo}`,
    timestampCols: ["updatedAt"],
  },
  {
    name: "SalesClaimDefaultSplit",
    columns: ["organizationId", "defaultId", "roleLabel", "splitType", "splitValue", "sortOrder"],
    naturalKey: (r) => `${r.defaultId}|${r.roleLabel}|${r.sortOrder}`,
    fkRemap: { fkColumn: "defaultId", parentTable: "SalesClaimDefault" },
  },
];

interface ParentMap {
  // For FK remap. natural-key (of the parent) → uat parent id
  // Built by querying both source and target after each parent table is processed.
  [parentTable: string]: Map<string, string>;
}

async function fetchRows(c: Client, table: string, orgId: string): Promise<RowMap[]> {
  const r = await c.query(`SELECT * FROM "${table}" WHERE "organizationId" = $1`, [orgId]);
  return r.rows;
}

async function buildParentMap(target: Client, parentTable: string): Promise<Map<string, string>> {
  // For each parent table referenced by a FK, build a map: parent natural-key (in DEV terms) → target.id.
  // For RenovationPackage: key
  // For SalesClaimDefault: appliesTo
  const map = new Map<string, string>();
  if (parentTable === "RenovationPackage") {
    const r = await target.query(`SELECT id, "key" FROM "RenovationPackage" WHERE "organizationId" = $1`, [ORG.uat]);
    for (const row of r.rows) map.set(`${row.key}`, row.id);
  } else if (parentTable === "SalesClaimDefault") {
    const r = await target.query(`SELECT id, "appliesTo" FROM "SalesClaimDefault" WHERE "organizationId" = $1`, [ORG.uat]);
    for (const row of r.rows) map.set(`${row.appliesTo}`, row.id);
  }
  return map;
}

async function buildSourceParentLookup(source: Client, parentTable: string): Promise<Map<string, string>> {
  // source.id → parent natural-key — used to look up the dev parent for each FK-bearing child row.
  const map = new Map<string, string>();
  if (parentTable === "RenovationPackage") {
    const r = await source.query(`SELECT id, "key" FROM "RenovationPackage" WHERE "organizationId" = $1`, [ORG.dev]);
    for (const row of r.rows) map.set(row.id, `${row.key}`);
  } else if (parentTable === "SalesClaimDefault") {
    const r = await source.query(`SELECT id, "appliesTo" FROM "SalesClaimDefault" WHERE "organizationId" = $1`, [ORG.dev]);
    for (const row of r.rows) map.set(row.id, `${row.appliesTo}`);
  }
  return map;
}

async function existingNaturalKeys(target: Client, spec: TableSpec): Promise<Set<string>> {
  const cols = spec.columns.join('", "');
  const r = await target.query(`SELECT "${cols}" FROM "${spec.name}" WHERE "organizationId" = $1`, [ORG.uat]);
  const keys = new Set<string>();
  for (const row of r.rows) {
    keys.add(spec.naturalKey(row as RowMap));
  }
  return keys;
}

async function insertRow(target: Client, spec: TableSpec, row: RowMap): Promise<void> {
  const cols: string[] = ["id", ...spec.columns];
  const vals: unknown[] = [randomUUID()];
  for (const col of spec.columns) {
    if (col === "organizationId") {
      vals.push(ORG.uat);
    } else {
      vals.push(row[col]);
    }
  }
  for (const ts of spec.timestampCols ?? []) {
    cols.push(ts);
    vals.push(new Date());
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  const colList = cols.map((c) => `"${c}"`).join(", ");
  await target.query(`INSERT INTO "${spec.name}" (${colList}) VALUES (${placeholders})`, vals);
}

async function main(): Promise<void> {
  const sourceUrl = readSourceUrl();
  const targetUrl = readTargetUrl();
  console.log("Source:", sourceUrl.replace(/:[^@]+@/, ":<REDACTED>@"));
  console.log("Target:", targetUrl.replace(/:[^@]+@/, ":<REDACTED>@"));

  // Strip ?sslmode=... query — pg v8.16+ treats it as verify-full, which fails
  // against Supabase's chain. We pass ssl options explicitly instead.
  const stripSsl = (u: string) => u.replace(/[?&]sslmode=[^&]*/, "").replace(/[?&]$/, "");
  const source = new Client({ connectionString: stripSsl(sourceUrl), ssl: { rejectUnauthorized: false } });
  const target = new Client({ connectionString: stripSsl(targetUrl), ssl: { rejectUnauthorized: false } });
  await source.connect();
  await target.connect();

  await target.query("BEGIN");
  try {
    let totalInserted = 0;
    const summary: { table: string; sourceRows: number; existing: number; inserted: number }[] = [];

    for (const spec of TABLES) {
      const sourceRows = await fetchRows(source, spec.name, ORG.dev);
      const existing = await existingNaturalKeys(target, spec);
      let inserted = 0;

      // For FK-bearing tables, build the lookup maps once per table.
      let devParentLookup: Map<string, string> | null = null;
      let uatParentMap: Map<string, string> | null = null;
      if (spec.fkRemap) {
        devParentLookup = await buildSourceParentLookup(source, spec.fkRemap.parentTable);
        uatParentMap = await buildParentMap(target, spec.fkRemap.parentTable);
      }

      for (const row of sourceRows) {
        const remappedRow: RowMap = { ...row };

        // Re-point FK from dev parent.id → uat parent.id (via natural key)
        if (spec.fkRemap && devParentLookup && uatParentMap) {
          const devParentId = row[spec.fkRemap.fkColumn] as string;
          const parentNatKey = devParentLookup.get(devParentId);
          if (!parentNatKey) {
            console.warn(`  [skip] ${spec.name} row references unknown dev parent ${devParentId}`);
            continue;
          }
          const uatParentId = uatParentMap.get(parentNatKey);
          if (!uatParentId) {
            console.warn(`  [skip] ${spec.name} row's parent natural-key "${parentNatKey}" not found in UAT`);
            continue;
          }
          remappedRow[spec.fkRemap.fkColumn] = uatParentId;
        }

        const natKey = spec.naturalKey(remappedRow);
        if (existing.has(natKey)) continue;

        await insertRow(target, spec, remappedRow);
        inserted += 1;
        totalInserted += 1;
      }

      summary.push({
        table: spec.name,
        sourceRows: sourceRows.length,
        existing: existing.size,
        inserted,
      });
      console.log(`  ${spec.name.padEnd(26)} dev=${sourceRows.length}  uat-existing=${existing.size}  inserted=${inserted}`);
    }

    await target.query("COMMIT");
    console.log("");
    console.log(`Done. Total rows inserted: ${totalInserted}`);
    console.log("");
    console.log("Summary:");
    console.table(summary);
  } catch (err) {
    await target.query("ROLLBACK");
    console.error("ROLLED BACK due to error:", err);
    process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
