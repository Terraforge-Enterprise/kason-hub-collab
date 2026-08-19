// scripts/report-mixed-listing-modes.ts
// Read-only. Reports unit-groups (propertyId+unitCode) whose active sibling
// Units reference RoomType rows of different `kind` values.

import "dotenv/config";
import { db } from "@kason/db";

async function main() {
  try {
    const roomTypes = await db.roomType.findMany({
      select: { name: true, kind: true, organizationId: true },
    });
    const kindByOrgAndName = new Map<string, "WHOLE" | "PARTITION">();
    for (const rt of roomTypes) {
      kindByOrgAndName.set(`${rt.organizationId}:${rt.name}`, rt.kind as "WHOLE" | "PARTITION");
    }

    const units = await db.unit.findMany({
      where: { listingStatus: { not: "archived" } },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        unitCode: true,
        unitType: true,
      },
    });

    const groups = new Map<string, { kinds: Set<string>; unitIds: string[]; key: string }>();
    for (const u of units) {
      const key = `${u.organizationId}:${u.propertyId}:${u.unitCode}`;
      const k = kindByOrgAndName.get(`${u.organizationId}:${u.unitType}`);
      if (!k) continue;
      const slot = groups.get(key) ?? { kinds: new Set(), unitIds: [], key };
      slot.kinds.add(k);
      slot.unitIds.push(u.id);
      groups.set(key, slot);
    }

    const mixed = [...groups.values()].filter((g) => g.kinds.size > 1);
    if (mixed.length === 0) {
      console.log("No mixed-kind unit groups found.");
      return;
    }

    console.log(`Found ${mixed.length} mixed-kind unit groups:`);
    for (const g of mixed) {
      console.log(`  ${g.key} — kinds: [${[...g.kinds].join(", ")}] — units: [${g.unitIds.join(", ")}]`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
