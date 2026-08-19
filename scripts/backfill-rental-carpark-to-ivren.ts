// scripts/backfill-rental-carpark-to-ivren.ts
//
// ONE-TIME BACKFILL (accounting-doc redesign P2, 2026-07-22): repoint each org's
// existing `rental` + `carpark` ChargeCategory rows from the shared DEP debit-note
// series to their OWN `IVREN` ("Rental Bill") series. New orgs get IVREN directly
// from the seed (packages/shared/src/constants/seed-categories.ts); this backfill
// fixes orgs seeded BEFORE the change.
//
// Forward-only + safe: an issued BillingDocument copies its own seriesId at issue
// time, so repointing a CATEGORY never rewrites a historical DEP rent document —
// it only changes the series FUTURE rent charges mint on.
//
// ensureChargeCategorySeeds runs first (create-only) so an IVREN DocumentSeries is
// guaranteed to exist per org. Idempotent: only rows whose seriesId != the IVREN
// series id are touched; a re-run after --apply reports 0.
//
//   npx tsx scripts/backfill-rental-carpark-to-ivren.ts            # dry-run
//   npx tsx scripts/backfill-rental-carpark-to-ivren.ts --apply    # write
//   DATABASE_URL=<target-db> npx tsx scripts/backfill-rental-carpark-to-ivren.ts --apply

import "dotenv/config";
import { db } from "@kason/db";
import { ensureChargeCategorySeeds } from "../apps/api/src/modules/charge-categories/seed";

/** The Rental-Bill category codes that move off the shared DEP series (spec P2). */
export const RENTAL_BILL_CATEGORY_CODES = ["rental", "carpark"] as const;

/**
 * The Rental-Bill series code, in preference order.
 *
 * ⚠️ THIS SCRIPT SILENTLY DID NOTHING FROM THE IVREN→RB RENAME UNTIL 2026-08-01.
 * It looked up `code: "IVREN"`, but the rename left SEED_DOCUMENT_SERIES emitting
 * only "RB". So `ensureChargeCategorySeeds` created RB, the lookup found no IVREN,
 * and the script printed "SKIP — no IVREN series after seed (unexpected)" and
 * repointed 0 rows — while REPORTING SUCCESS with exit code 0. Every org kept
 * minting rent onto the shared DEP debit-note series, which is how a monthly rent
 * charge ends up as "Debit Note · DEP-0001".
 *
 * RB is now preferred, with IVREN accepted as a fallback so an org repointed BEFORE
 * the rename is still recognised as already-done rather than repointed a second time.
 */
const RENTAL_BILL_SERIES_CODES = ["RB", "IVREN"] as const;

/** Resolve the org's Rental-Bill series, preferring RB over the legacy IVREN. */
export function pickRentalBillSeries<T extends { id: string; code: string }>(
  series: T[],
): T | null {
  for (const code of RENTAL_BILL_SERIES_CODES) {
    const hit = series.find((s) => s.code === code);
    if (hit) return hit;
  }
  return null;
}

/** PURE selection logic (unit-tested): given an org's rental/carpark categories and
 * the org's Rental-Bill series id, return the ones that still need repointing
 * (seriesId not already that series). Drives the write below so the tested logic IS
 * the applied one. */
export function categoriesToRepoint(
  cats: { id: string; code: string; seriesId: string }[],
  rentalBillSeriesId: string,
): { id: string; code: string }[] {
  const codes = new Set<string>(RENTAL_BILL_CATEGORY_CODES);
  return cats
    .filter((c) => codes.has(c.code) && c.seriesId !== rentalBillSeriesId)
    .map((c) => ({ id: c.id, code: c.code }));
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: --apply (writing)" : "MODE: dry-run (pass --apply to write)");

  const orgs = await db.organization.findMany({ select: { id: true, name: true } });
  let grandTotal = 0;
  let skippedOrgs = 0;

  for (const org of orgs) {
    await ensureChargeCategorySeeds(org.id); // guarantees the RB series exists
    const candidates = await db.documentSeries.findMany({
      where: { organizationId: org.id, code: { in: [...RENTAL_BILL_SERIES_CODES] } },
      select: { id: true, code: true },
    });
    const rentalBill = pickRentalBillSeries(candidates);
    if (!rentalBill) {
      // Genuinely unexpected now: the seeder creates RB for every org. Loud, and
      // NOT counted as success — the old wording made a total no-op read as "fine".
      console.log(
        `\n[${org.name}] SKIP — no RB (or legacy IVREN) series after seed. Rent will keep minting on DEP.`,
      );
      skippedOrgs += 1;
      continue;
    }
    const cats = await db.chargeCategory.findMany({
      where: { organizationId: org.id, code: { in: [...RENTAL_BILL_CATEGORY_CODES] } },
      select: { id: true, code: true, seriesId: true },
    });
    const toRepoint = categoriesToRepoint(cats, rentalBill.id);
    if (toRepoint.length === 0) {
      console.log(`\n[${org.name}] OK — rental/carpark already on ${rentalBill.code} (or absent).`);
      continue;
    }
    console.log(`\n[${org.name}] ${toRepoint.length} category(ies) → ${rentalBill.code}:`);
    for (const t of toRepoint) console.log(`  ${t.code} (${t.id})`);
    grandTotal += toRepoint.length;

    if (apply) {
      const res = await db.chargeCategory.updateMany({
        where: { organizationId: org.id, id: { in: toRepoint.map((t) => t.id) } },
        data: { seriesId: rentalBill.id },
      });
      console.log(`  → updated ${res.count} row(s).`);
    }
  }

  console.log(`\n${apply ? "APPLIED" : "DRY-RUN"} — ${grandTotal} row(s) across ${orgs.length} org(s).`);
  if (skippedOrgs > 0) {
    // Exit non-zero so a skipped org can never again read as a clean run. The
    // IVREN→RB rename turned this whole script into a silent no-op precisely
    // because "skipped everything" and "nothing to do" looked identical.
    console.error(`\n${skippedOrgs} org(s) SKIPPED — rent still mints on DEP there.`);
    await db.$disconnect();
    process.exit(1);
  }
  await db.$disconnect();
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1].includes("backfill-rental-carpark-to-ivren")) {
  main().catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
}
