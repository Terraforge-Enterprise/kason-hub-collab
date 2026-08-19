// scripts/backfill-charge-categories.ts
//
// ONE-TIME BACKFILL (accounting-docs P1, spec §4.5): map legacy free-text
// Charge.chargeType strings onto the seeded ChargeCategory registry and set
// Charge.categoryId. Unmapped chargeTypes land in the `legacy_other` bucket
// (inactive category, flagged for admin review).
//
// Dry-run by default (prints a per-org chargeType → code table + counts).
// Idempotent: only touches rows WHERE categoryId IS NULL; a re-run after
// --apply reports 0 rows.
//
//   npx tsx scripts/backfill-charge-categories.ts            # dry-run
//   npx tsx scripts/backfill-charge-categories.ts --apply    # write
//   DATABASE_URL=<target-db> npx tsx scripts/backfill-charge-categories.ts --apply

import "dotenv/config";
import { db } from "@kason/db";
import { ensureChargeCategorySeeds } from "../apps/api/src/modules/charge-categories/seed";

/** Contract mapping (spec §4.5): legacy chargeType → seeded category code. */
export const CHARGE_TYPE_TO_CATEGORY_CODE: Record<string, string> = {
  rent: "rental",
  rental: "rental",
  utility: "utility_tnb",
  aircond: "aircond",
  carpark: "carpark",
  cleaning: "cleaning_tenant",
  management_fee: "management_fee",
  access_card: "access_card_replacement",
  tnb: "utility_tnb",
  wifi: "utility_wifi",
};

export function resolveCategoryCode(chargeType: string): string {
  return CHARGE_TYPE_TO_CATEGORY_CODE[chargeType.trim().toLowerCase()] ?? "legacy_other";
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: --apply (writing)" : "MODE: dry-run (pass --apply to write)");

  try {
    const orgs = await db.organization.findMany({ select: { id: true, name: true } });
    let grandTotal = 0;

    for (const org of orgs) {
      // Seeds must exist before we can resolve codes → ids (idempotent).
      await ensureChargeCategorySeeds(org.id);
      const categories = await db.chargeCategory.findMany({
        where: { organizationId: org.id },
        select: { id: true, code: true },
      });
      const idByCode = new Map(categories.map((c) => [c.code, c.id]));

      const groups = await db.charge.groupBy({
        by: ["chargeType"],
        where: { organizationId: org.id, categoryId: null },
        _count: { _all: true },
      });

      if (groups.length === 0) {
        console.log(`\n[${org.name}] OK — no category-less charges. Nothing to backfill.`);
        continue;
      }

      console.log(`\n[${org.name}] ${groups.length} distinct chargeType value(s) with categoryId IS NULL:`);
      for (const g of groups) {
        const code = resolveCategoryCode(g.chargeType);
        const flag = code === "legacy_other" ? "  ← REVIEW (unmapped)" : "";
        console.log(`  ${JSON.stringify(g.chargeType).padEnd(24)} → ${code.padEnd(24)} (${g._count._all} rows)${flag}`);
        grandTotal += g._count._all;

        if (apply) {
          const categoryId = idByCode.get(code);
          if (!categoryId) {
            console.error(`  !! category code "${code}" missing after seeding — skipped`);
            continue;
          }
          const res = await db.charge.updateMany({
            where: { organizationId: org.id, chargeType: g.chargeType, categoryId: null },
            data: { categoryId },
          });
          console.log(`     applied: ${res.count} rows updated`);
        }
      }
    }

    console.log(`\n${apply ? "APPLIED" : "WOULD APPLY"}: ${grandTotal} charge rows across ${orgs.length} org(s).`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
