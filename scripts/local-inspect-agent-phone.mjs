#!/usr/bin/env node
// Read-only: check whether Priya's primaryPhone is set in the LOCAL dev DB,
// and whether readPhoneAnyFormat can parse it. User report 2026-05-25: agent
// phone shows '-' on admin claim detail despite agent having a phone.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const env = readFileSync(path.join(repoRoot, ".env"), "utf8").trim();
const dbLine = env.split("\n").find((l) => l.startsWith("DATABASE_URL"));
const url = dbLine.replace(/^DATABASE_URL=/, "").replace(/^"(.*)"$/, "$1");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const r = await client.query(`
    SELECT
      p.id,
      p."displayName",
      p."primaryPhone",
      p."primaryEmail",
      (
        SELECT cc."claimNumber"
        FROM "CommissionClaim" cc
        WHERE cc."agentPartyId" = p.id
        ORDER BY cc."createdAt" DESC
        LIMIT 1
      ) AS latest_claim
    FROM "Party" p
    WHERE p."displayName" ILIKE 'priya%'
       OR p."primaryEmail" ILIKE 'priya%'
    ORDER BY p."createdAt" DESC
    LIMIT 5
  `);
  if (r.rows.length === 0) {
    console.log("No Party found matching 'priya'.");
    process.exit(0);
  }
  for (const row of r.rows) {
    console.log("---");
    console.log("partyId      :", row.id);
    console.log("displayName  :", row.displayName);
    console.log("primaryEmail :", JSON.stringify(row.primaryEmail));
    console.log("primaryPhone :", JSON.stringify(row.primaryPhone));
    console.log("latest claim :", row.latest_claim ?? "(none)");
  }
  console.log();
  console.log("If primaryPhone is null/empty → data issue, agent needs to fill phone.");
  console.log("If primaryPhone IS set → parser bug in readPhoneAnyFormat / normalizeMyPhone.");
} finally {
  await client.end();
}
