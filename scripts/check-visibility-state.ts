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

  const counts: { kind: string; n: bigint }[] = await prisma.$queryRawUnsafe(`
    SELECT 'total_units' AS kind, count(*)::bigint AS n FROM "Unit"
    UNION ALL SELECT 'units_RESTRICTED', count(*)::bigint FROM "Unit" WHERE "visibilityMode" = 'RESTRICTED'
    UNION ALL SELECT 'units_PUBLIC', count(*)::bigint FROM "Unit" WHERE "visibilityMode" = 'PUBLIC'
    UNION ALL SELECT 'units_with_hiddenFromPartyIds', count(*)::bigint FROM "Unit" WHERE array_length("hiddenFromPartyIds", 1) > 0
    UNION ALL SELECT 'total_grants', count(*)::bigint FROM "ListingVisibilityGrant"
    UNION ALL SELECT 'units_with_at_least_one_grant', count(DISTINCT "unitId")::bigint FROM "ListingVisibilityGrant"
  `);
  counts.forEach((c) => console.log(`${c.kind.padEnd(35)} ${c.n}`));

  console.log("\n=== RESTRICTED units (should have grants to be visible to anyone) ===");
  const restricted: { unitCode: string; propertyName: string; hidden: number; grants: bigint }[] =
    await prisma.$queryRawUnsafe(`
      SELECT u."unitCode",
             p.name AS "propertyName",
             COALESCE(array_length(u."hiddenFromPartyIds", 1), 0) AS hidden,
             COUNT(g.id)::bigint AS grants
      FROM "Unit" u
      JOIN "Property" p ON p.id = u."propertyId"
      LEFT JOIN "ListingVisibilityGrant" g ON g."unitId" = u.id
      WHERE u."visibilityMode" = 'RESTRICTED'
      GROUP BY u.id, u."unitCode", p.name, u."hiddenFromPartyIds"
      ORDER BY p.name, u."unitCode"
    `);
  if (restricted.length === 0) console.log("  (none)");
  restricted.forEach((u) =>
    console.log(`  ${u.propertyName} / ${u.unitCode}  hiddenFromPartyIds=${u.hidden}  grants=${u.grants}`)
  );

  console.log("\n=== Units with hiddenFromPartyIds set (any visibility mode) ===");
  const hidden: { unitCode: string; propertyName: string; visibilityMode: string; hidden: number }[] =
    await prisma.$queryRawUnsafe(`
      SELECT u."unitCode", p.name AS "propertyName", u."visibilityMode",
             array_length(u."hiddenFromPartyIds", 1) AS hidden
      FROM "Unit" u
      JOIN "Property" p ON p.id = u."propertyId"
      WHERE array_length(u."hiddenFromPartyIds", 1) > 0
      ORDER BY p.name, u."unitCode"
    `);
  if (hidden.length === 0) console.log("  (none)");
  hidden.forEach((u) =>
    console.log(`  ${u.propertyName} / ${u.unitCode}  mode=${u.visibilityMode}  hidden=${u.hidden}`)
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
