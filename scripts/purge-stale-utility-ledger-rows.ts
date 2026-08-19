// scripts/purge-stale-utility-ledger-rows.ts
//
// ONE-TIME DEPLOY CLEANUP (sub-project C / owner-billing gross sync).
//
// The gross owner-ledger sync replaced the single aggregate OwnerLedgerEntry
// with sourceType="utility" (ownerBorneUtilitiesTotal) with per-category rows
// sourceType in {utility_tnb, utility_water, utility_indah_water, utility_wifi}.
// Any environment that ran the OLD sync still holds stale "utility" rows; on the
// next re-sync they DOUBLE-COUNT against the new per-category rows → owners are
// SILENTLY UNDERPAID. This script finds and (with --apply) deletes those stale
// rows so the next sync re-projects cleanly.
//
// Dry-run by default. Idempotent (re-run after --apply → 0 rows). The next
// owner-ledger sync (post / payment / on-demand view) re-creates the correct
// per-category rows; the sync is keyed/idempotent, so no data is lost.
//
//   npx tsx scripts/purge-stale-utility-ledger-rows.ts               # dry-run: count + per-org summary + sample
//   npx tsx scripts/purge-stale-utility-ledger-rows.ts --apply       # DELETE the stale rows
//   DATABASE_URL=<target-db> npx tsx scripts/purge-stale-utility-ledger-rows.ts --apply

import "dotenv/config";
import { db } from "@kason/db";

// The OLD aggregate sourceType. The new gross sync uses the per-category set below.
const STALE_SOURCE_TYPE = "utility";
const NEW_PER_CATEGORY = ["utility_tnb", "utility_water", "utility_indah_water", "utility_wifi"];

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    const rows = await db.ownerLedgerEntry.findMany({
      where: { sourceType: STALE_SOURCE_TYPE },
      select: {
        id: true,
        organizationId: true,
        ownerPartyId: true,
        statementMonth: true,
        amount: true,
        sourceUtilityBillId: true,
      },
      orderBy: [{ organizationId: "asc" }, { statementMonth: "asc" }],
    });

    // Sanity: how many NEW per-category rows already exist (so the operator can
    // see the double-count surface).
    const newCount = await db.ownerLedgerEntry.count({
      where: { sourceType: { in: NEW_PER_CATEGORY } },
    });
    console.log(`(context) per-category rows already present: ${newCount}`);

    if (rows.length === 0) {
      console.log(`OK — no stale sourceType="${STALE_SOURCE_TYPE}" OwnerLedgerEntry rows. Nothing to purge.`);
      return;
    }

    // Per-org summary.
    const byOrg = new Map<string, { count: number; totalC: number }>();
    for (const r of rows) {
      const slot = byOrg.get(r.organizationId) ?? { count: 0, totalC: 0 };
      slot.count += 1;
      slot.totalC += Math.round(Number(r.amount.toString()) * 100);
      byOrg.set(r.organizationId, slot);
    }

    console.log(
      `Found ${rows.length} stale sourceType="${STALE_SOURCE_TYPE}" OwnerLedgerEntry row(s) across ${byOrg.size} org(s):`,
    );
    for (const [org, s] of byOrg) {
      console.log(`  org ${org}: ${s.count} row(s), total RM ${(s.totalC / 100).toFixed(2)}`);
    }
    console.log("Sample (first 10):");
    for (const r of rows.slice(0, 10)) {
      console.log(
        `  ${r.id} · owner ${r.ownerPartyId} · ${r.statementMonth
          .toISOString()
          .slice(0, 7)} · RM ${Number(r.amount.toString()).toFixed(2)} · bill ${
          r.sourceUtilityBillId ?? "-"
        }`,
      );
    }

    if (!apply) {
      console.log(
        `\nDRY-RUN — nothing deleted. Re-run with --apply to DELETE these ${rows.length} row(s), then re-run the owner-ledger sync.`,
      );
      return;
    }

    const result = await db.ownerLedgerEntry.deleteMany({ where: { sourceType: STALE_SOURCE_TYPE } });
    console.log(
      `\nDELETED ${result.count} stale sourceType="${STALE_SOURCE_TYPE}" row(s). The next owner-ledger sync re-projects the correct per-category rows.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
