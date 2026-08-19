// scripts/report-split-owner-apartments.ts
// Read-only. Reports apartments whose non-archived Listings (rooms + carparks)
// reference 2+ distinct non-null ownerPartyId values — a violation of the
// one-owner-per-apartment invariant.

import "dotenv/config";
import { db } from "@kason/db";

async function main() {
  try {
    const listings = await db.listing.findMany({
      where: { listingStatus: { not: "archived" } },
      select: {
        id: true,
        apartmentId: true,
        ownerPartyId: true,
        apartment: { select: { unitCode: true } },
      },
    });

    const byApartment = new Map<
      string,
      { unitCode: string; owners: Set<string>; listingIds: string[] }
    >();
    for (const l of listings) {
      const slot =
        byApartment.get(l.apartmentId) ??
        { unitCode: l.apartment.unitCode, owners: new Set<string>(), listingIds: [] };
      if (l.ownerPartyId) slot.owners.add(l.ownerPartyId);
      slot.listingIds.push(l.id);
      byApartment.set(l.apartmentId, slot);
    }

    const split = [...byApartment.entries()].filter(([, v]) => v.owners.size > 1);
    if (split.length === 0) {
      console.log("No split-owner apartments found.");
      return;
    }

    console.log(`Found ${split.length} split-owner apartment(s):`);
    for (const [apartmentId, v] of split) {
      console.log(
        `  ${v.unitCode} (apartment ${apartmentId}) — owners: [${[...v.owners].join(", ")}] — listings: [${v.listingIds.join(", ")}]`,
      );
    }
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
