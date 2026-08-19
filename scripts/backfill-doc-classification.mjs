#!/usr/bin/env node
// One-shot, idempotent backfill for BillingDocument classification columns.
//
// WHY: commercialDocumentType/ledgerTreatment are only written by the
// ENABLE_PHASE2_RENT_RECLASSIFICATION path in issue.service.ts. Every document
// minted through any other route — the bills-grid grouped path especially, which
// resolves its series from the charge's CATEGORY — was written with both columns
// NULL. A NULL ledgerTreatment makes a document unrecognisable to consumers that
// read it: the owner-receivable offset guard requires MANAGER_REVENUE and so
// rejected the very IVOWN invoices this system mints.
//
// issue.service.ts now derives these at mint time for new documents. This script
// closes the same gap for documents already on disk.
//
// SCOPE — deliberately narrow, matching CLASSIFICATION_FOR_DEFAULT_SERIES:
//   • docType 'invoice' only (a CN/DN/RN against an IVOWN invoice is a different
//     economic act; the forward map classifies invoices only)
//   • series IVOWN -> OWNER_SERVICE_INVOICE  / MANAGER_REVENUE
//   • series IVTEN -> TENANT_SERVICE_INVOICE / MANAGER_REVENUE
//   • ONLY rows where BOTH columns are currently NULL — never overwrites a value
//
// RB is deliberately NOT backfilled: its ledgerTreatment is unambiguously
// PAYABLE_TO_OWNER, but its commercial type could be RENTAL_INVOICE or
// OWNER_COLLECTION_INVOICE. A half-filled classification is worse than an honest
// null, because a later pass can no longer tell a derived value from a real one.
//
// Run per-env:
//   node scripts/backfill-doc-classification.mjs                 # local
//   DATABASE_URL=$SUPABASE_DATABASE_URL node scripts/backfill-doc-classification.mjs
//
// --dry-run prints the counts and changes nothing.
// Safe to re-run: the WHERE clause excludes rows already populated.
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dotenv = readFileSync(path.join(repoRoot, ".env"), "utf8");
  const line = dotenv.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not set and not found in .env");
  return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
}

const rawUrl = loadDatabaseUrl();
// Strip sslmode from URL — newer pg treats `sslmode=require` as verify-full,
// which rejects Supabase pooler self-signed certs. We pass our own SSL config so
// connections still go over TLS, just without strict CA verification.
const sanitizedUrl = rawUrl.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
const url = new URL(sanitizedUrl);
const host = url.hostname;
const ssl = host === "localhost" || host === "127.0.0.1" ? false : { rejectUnauthorized: false };

// series code -> [commercialDocumentType, ledgerTreatment]. Mirrors
// CLASSIFICATION_FOR_DEFAULT_SERIES in packages/shared/src/constants/series-mapping.ts;
// keep the two in step.
const CLASSIFICATION_BY_SERIES = {
  IVOWN: ["OWNER_SERVICE_INVOICE", "MANAGER_REVENUE"],
  IVTEN: ["TENANT_SERVICE_INVOICE", "MANAGER_REVENUE"],
};

const client = new pg.Client({ connectionString: sanitizedUrl, ssl });
await client.connect();

try {
  const before = await client.query(
    `SELECT s.code, COUNT(*)::int AS n
       FROM "BillingDocument" d
       JOIN "DocumentSeries" s ON s.id = d."seriesId"
      WHERE d."docType" = 'invoice'
        AND d."commercialDocumentType" IS NULL
        AND d."ledgerTreatment" IS NULL
        AND s.code = ANY($1::text[])
      GROUP BY s.code
      ORDER BY s.code`,
    [Object.keys(CLASSIFICATION_BY_SERIES)],
  );

  if (before.rows.length === 0) {
    console.log(`[${host}] Nothing to backfill — every IVOWN/IVTEN invoice is already classified.`);
  } else {
    console.log(`[${host}] Unclassified invoices found:`);
    for (const r of before.rows) console.log(`  ${r.code}: ${r.n}`);
  }

  if (DRY_RUN) {
    console.log("--dry-run: no changes written.");
  } else {
    let total = 0;
    for (const [code, [cdt, lt]] of Object.entries(CLASSIFICATION_BY_SERIES)) {
      const res = await client.query(
        `UPDATE "BillingDocument" d
            SET "commercialDocumentType" = $2,
                "ledgerTreatment" = $3,
                "updatedAt" = NOW()
           FROM "DocumentSeries" s
          WHERE s.id = d."seriesId"
            AND s.code = $1
            AND d."docType" = 'invoice'
            AND d."commercialDocumentType" IS NULL
            AND d."ledgerTreatment" IS NULL`,
        [code, cdt, lt],
      );
      if (res.rowCount > 0) console.log(`  ${code}: updated ${res.rowCount} -> ${cdt} / ${lt}`);
      total += res.rowCount;
    }
    console.log(`[${host}] Backfill complete. ${total} document(s) classified.`);
  }

  // Report what remains unclassified so the gap is visible rather than assumed closed.
  const remaining = await client.query(
    `SELECT s.code, d."docType", COUNT(*)::int AS n
       FROM "BillingDocument" d
       JOIN "DocumentSeries" s ON s.id = d."seriesId"
      WHERE d."ledgerTreatment" IS NULL
      GROUP BY s.code, d."docType"
      ORDER BY s.code, d."docType"`,
  );
  if (remaining.rows.length > 0) {
    console.log(`[${host}] Still unclassified (out of scope — see the header comment):`);
    for (const r of remaining.rows) console.log(`  ${r.code} / ${r.docType}: ${r.n}`);
  }
} finally {
  await client.end();
}
