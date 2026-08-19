import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getDb } from "@kason/db";
import { buildStorageReconReport } from "./report";

// Load env from cwd AND repo root (mirrors apps/api/src/index.ts) so the CLI
// works whether invoked from the repo root or the apps/api workspace dir.
dotenv.config({ path: resolve(process.cwd(), ".env") });
dotenv.config({ path: resolve(process.cwd(), "../../.env") });

/* eslint-disable no-console */

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function main(): Promise<void> {
  const report = await buildStorageReconReport(getDb());

  console.log("=== Supabase Storage Reconciliation (READ-ONLY — deletes nothing) ===");
  console.log("");
  console.log(`Total bucket objects:   ${report.totalBucketObjects}`);
  console.log(`Total referenced keys:  ${report.totalReferencedKeys}`);
  console.log(
    `Orphans (bucket only):  ${report.orphanCount} (${formatMB(report.orphanBytes)} MB)`,
  );
  console.log(`Dangling refs (db only):${report.danglingCount}`);
  console.log("");

  console.log("--- Scanned columns (manifest) ---");
  for (const entry of report.manifest) {
    console.log(`  ${entry.model}.${entry.column}: ${entry.count}`);
  }
  console.log(`  (${report.manifest.length} columns scanned)`);
  console.log("");

  console.log(`--- Orphans (${report.orphans.length}) — objects in bucket with NO db reference ---`);
  for (const key of report.orphans) console.log(`  ${key}`);
  console.log("");

  console.log(
    `--- Dangling refs (${report.danglingRefs.length}) — db keys whose object is MISSING ---`,
  );
  for (const key of report.danglingRefs) console.log(`  ${key}`);
  console.log("");

  // No silent caps: both lists are printed in full above. If a future change
  // truncates either list, print an explicit note here instead of dropping rows.
  console.log("Done. No objects were deleted.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    })
    .finally(() => {
      getDb()
        .$disconnect()
        .catch(() => {
          // disconnect is best-effort; swallow errors
        });
    });
}
