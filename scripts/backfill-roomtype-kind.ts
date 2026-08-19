// scripts/backfill-roomtype-kind.ts
// UPDATE-only. No row deletion. Idempotent. Safe to re-run.
//
// Sets RoomType.kind = "WHOLE" for rows whose name (trimmed, lower-cased)
// matches one of: "studio", "whole unit", "whole-unit".
// Leaves everything else at the column default ("PARTITION").

import "dotenv/config";
import { db } from "@kason/db";

const WHOLE_NAMES = new Set(["studio", "whole unit", "whole-unit"]);

async function main() {
  try {
    const all = await db.roomType.findMany({
      select: { id: true, name: true, kind: true, organizationId: true },
    });

    let flipped = 0;
    for (const r of all) {
      const key = r.name.trim().toLowerCase();
      const target = WHOLE_NAMES.has(key) ? "WHOLE" : "PARTITION";
      if (r.kind === target) continue;
      await db.roomType.update({
        where: { id: r.id },
        data: { kind: target },
      });
      console.log(`[${r.organizationId}] "${r.name}" -> ${target}`);
      flipped++;
    }

    console.log(`Done. Scanned ${all.length} rows; updated ${flipped}.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
