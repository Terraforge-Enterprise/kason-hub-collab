#!/usr/bin/env node
// One-off: update Priya's primaryPhone from the invalid "60152345678" (9-digit
// subscriber on '015' carrier — spec says 015 needs 10 digits) to a valid test
// number "60195551234" (019 carrier, 9-digit subscriber — passes strict check).
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
  const NEW_PHONE = "60195551234";
  const r = await client.query(
    `UPDATE "Party"
       SET "primaryPhone" = $1
     WHERE id = '2376317c-1c13-490e-b793-5f3b3217db68'
     RETURNING id, "displayName", "primaryPhone"`,
    [NEW_PHONE],
  );
  if (r.rowCount === 0) {
    console.log("No row updated. Aborted.");
    process.exit(1);
  }
  console.log("Updated:");
  console.log("  partyId      :", r.rows[0].id);
  console.log("  displayName  :", r.rows[0].displayName);
  console.log("  primaryPhone :", r.rows[0].primaryPhone);
} finally {
  await client.end();
}
