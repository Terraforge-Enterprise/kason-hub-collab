// Fix RESTRICTED-with-no-grants: those units are silently invisible to every
// agent. Caused by a form bug where the RESTRICTED option was labelled
// "hidden from selected agents" but the underlying code uses an allowlist
// (ListingVisibilityGrant). Form picker wrote to hiddenFromPartyIds, which
// the visibility check ignores when mode=RESTRICTED — net effect: nobody
// could see those units.
//
// Strategy: any RESTRICTED unit with zero grants is wrong (even an
// intentional private listing must have at least one grantee to be useful).
// Flip them to PUBLIC; they were almost certainly meant to be public when
// the operator picked them in the form.
//
// Idempotent. Dry-run by default; pass APPLY=1 to actually update.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const url = process.env.DATABASE_URL!
    .replace(/([?&])sslmode=[^&]*&?/g, "$1")
    .replace(/[?&]$/, "");
  const adapter = new PrismaPg({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  const orphans: {
    id: string;
    unitCode: string;
    propertyName: string;
    listingStatus: string;
    occupancyStatus: string;
    propertyStatus: string;
    grants: bigint;
  }[] = await prisma.$queryRawUnsafe(`
    SELECT u.id, u."unitCode", p.name AS "propertyName",
           u."listingStatus", u."occupancyStatus", p.status AS "propertyStatus",
           COUNT(g.id)::bigint AS grants
    FROM "Unit" u
    JOIN "Property" p ON p.id = u."propertyId"
    LEFT JOIN "ListingVisibilityGrant" g ON g."unitId" = u.id
    WHERE u."visibilityMode" = 'RESTRICTED'
    GROUP BY u.id, u."unitCode", p.name, u."listingStatus", u."occupancyStatus", p.status
    HAVING COUNT(g.id) = 0
    ORDER BY p.name, u."unitCode"
  `);

  console.log(`Found ${orphans.length} RESTRICTED-with-no-grants unit(s):`);
  orphans.forEach((u) =>
    console.log(`  ${u.propertyName} / ${u.unitCode}  listing=${u.listingStatus} occupancy=${u.occupancyStatus} propertyStatus=${u.propertyStatus}`)
  );

  if (orphans.length === 0) {
    console.log("Nothing to fix.");
    await prisma.$disconnect();
    return;
  }

  if (process.env.APPLY !== "1") {
    console.log("\n(dry run) — set APPLY=1 to actually update");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== APPLYING ===`);
  for (const u of orphans) {
    const newReadyNow =
      u.propertyStatus === "active" &&
      u.listingStatus === "active" &&
      u.occupancyStatus === "vacant";
    await prisma.$executeRawUnsafe(
      `UPDATE "Unit" SET "visibilityMode" = 'PUBLIC', "readyNow" = $2 WHERE id = $1`,
      u.id,
      newReadyNow,
    );
    console.log(`  ${u.propertyName} / ${u.unitCode} → PUBLIC, readyNow=${newReadyNow}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
