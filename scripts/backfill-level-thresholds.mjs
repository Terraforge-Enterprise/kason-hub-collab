#!/usr/bin/env node
// One-shot, idempotent backfill for AgentLevelThreshold defaults.
//
// Reads DATABASE_URL from env, finds every Organization missing one of the
// 3 expected agentLevel rows (new_agent=0, pre_leader=10000, leader=20000),
// inserts the missing ones, and prints a before/after summary.
//
// Run per-env:
//   node scripts/backfill-level-thresholds.mjs                                       # local
//   $env:DATABASE_URL=$env:SUPABASE_DATABASE_URL; node scripts/backfill-level-thresholds.mjs    # UAT
//   $env:DATABASE_URL=$env:DEV_SUPABASE_DATABASE_URL; node scripts/backfill-level-thresholds.mjs # dev/main
//
// Safe to re-run — uses INSERT ... WHERE NOT EXISTS.
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Fallback: pull from root .env if not in env.
  const dotenv = readFileSync(path.join(repoRoot, ".env"), "utf8");
  const line = dotenv.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not set and not found in .env");
  return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
}

const rawUrl = loadDatabaseUrl();
// Strip sslmode from URL — newer pg treats `sslmode=require` as verify-full,
// which rejects Supabase pooler self-signed certs. We then pass our own SSL
// config so connections still go over TLS, just without strict CA verification.
const sanitizedUrl = rawUrl.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
const url = new URL(sanitizedUrl);
const host = url.hostname;
const ssl = host === "localhost" || host === "127.0.0.1" ? false : { rejectUnauthorized: false };

const client = new pg.Client({ connectionString: sanitizedUrl, ssl });
await client.connect();

try {
  const before = await client.query(`
    SELECT COUNT(*)::int AS missing
    FROM "Organization" o
    CROSS JOIN (VALUES ('new_agent'), ('pre_leader'), ('leader')) AS t(level)
    WHERE NOT EXISTS (
      SELECT 1 FROM "AgentLevelThreshold" alt
      WHERE alt."organizationId" = o.id AND alt."agentLevel" = t.level
    )
  `);
  const missingBefore = before.rows[0].missing;
  console.log(`[${host}] Missing rows before backfill: ${missingBefore}`);

  if (missingBefore === 0) {
    console.log(`[${host}] Nothing to do.`);
  } else {
    // Some Supabase instances don't have gen_random_uuid() resolvable as a
    // column default (Prisma normally generates UUIDs client-side). Generate
    // explicitly so the INSERT works regardless.
    const missingRows = await client.query(`
      SELECT o.id AS org_id, t.level, t.amount
      FROM "Organization" o
      CROSS JOIN (VALUES ('new_agent', 0), ('pre_leader', 10000), ('leader', 20000)) AS t(level, amount)
      WHERE NOT EXISTS (
        SELECT 1 FROM "AgentLevelThreshold" alt
        WHERE alt."organizationId" = o.id AND alt."agentLevel" = t.level
      )
    `);
    let inserted = 0;
    for (const m of missingRows.rows) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO "AgentLevelThreshold" ("id", "organizationId", "agentLevel", "minCumulativeCommission", "createdAt", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3, $4::numeric, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT ("organizationId", "agentLevel") DO NOTHING`,
        [id, m.org_id, m.level, m.amount],
      );
      console.log(`  org=${m.org_id} level=${m.level} min=${m.amount}`);
      inserted += 1;
    }
    console.log(`[${host}] Inserted ${inserted} rows.`);
  }

  const after = await client.query(`
    SELECT COUNT(*)::int AS missing
    FROM "Organization" o
    CROSS JOIN (VALUES ('new_agent'), ('pre_leader'), ('leader')) AS t(level)
    WHERE NOT EXISTS (
      SELECT 1 FROM "AgentLevelThreshold" alt
      WHERE alt."organizationId" = o.id AND alt."agentLevel" = t.level
    )
  `);
  console.log(`[${host}] Missing rows after backfill: ${after.rows[0].missing}`);
} finally {
  await client.end();
}
