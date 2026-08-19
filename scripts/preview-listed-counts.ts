// Preview the new "Listed" count rule across every property:
//   Listed = listingStatus="active" AND occupancyStatus="vacant"
// Visibility mode is intentionally NOT in the gate.
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

  const rows: {
    propertyName: string;
    propertyCode: string;
    units: bigint;
    listed_new: bigint;
    listed_old: bigint;
    delta: bigint;
  }[] = await prisma.$queryRawUnsafe(`
    SELECT
      p.name AS "propertyName",
      p."propertyCode",
      COUNT(u.id)::bigint AS units,
      COUNT(*) FILTER (
        WHERE u."listingStatus" = 'active'
          AND u."occupancyStatus" = 'vacant'
      )::bigint AS listed_new,
      COUNT(*) FILTER (
        WHERE u."listingStatus" = 'active'
          AND u."visibilityMode" = 'PUBLIC'
      )::bigint AS listed_old,
      (
        COUNT(*) FILTER (
          WHERE u."listingStatus" = 'active'
            AND u."occupancyStatus" = 'vacant'
        ) - COUNT(*) FILTER (
          WHERE u."listingStatus" = 'active'
            AND u."visibilityMode" = 'PUBLIC'
        )
      )::bigint AS delta
    FROM "Property" p
    LEFT JOIN "Unit" u ON u."propertyId" = p.id
    GROUP BY p.id, p.name, p."propertyCode"
    ORDER BY p.name
  `);

  console.log(
    "Property                              Code     Units  Old→New  Δ"
  );
  console.log(
    "------------------------------------- -------- ----- -------- ---"
  );
  rows.forEach((r) => {
    const arrow = r.delta === 0n ? "      " : r.delta > 0n ? `  ↑+${r.delta}` : `  ↓${r.delta}`;
    console.log(
      `${r.propertyName.padEnd(37)} ${r.propertyCode.padEnd(8)} ${String(r.units).padStart(5)} ${String(r.listed_old).padStart(3)}→${String(r.listed_new).padEnd(3)}${arrow}`
    );
  });

  const totals = rows.reduce(
    (a, r) => ({ old: a.old + Number(r.listed_old), new: a.new + Number(r.listed_new) }),
    { old: 0, new: 0 }
  );
  console.log("");
  console.log(`Total Listed:  OLD=${totals.old}  NEW=${totals.new}  (Δ=${totals.new - totals.old})`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
