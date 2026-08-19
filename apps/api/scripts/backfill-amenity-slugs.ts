import "dotenv/config";
import { db as prisma } from "@kason/db";

const SLUG_DISPLAY: Record<string, string> = {
  parking: "Parking",
  gym: "Gym",
  pool: "Pool",
  security: "Security",
  concierge: "Concierge",
  loading_bay: "Loading Bay",
  playground: "Playground",
  sauna: "Sauna",
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not point at localhost. Got: ${url.replace(/:[^@]+@/, ":***@")}`,
    );
  }

  const orgRows = await prisma.$queryRaw<{ organizationId: string }[]>`
    SELECT DISTINCT "organizationId" FROM "Unit" WHERE array_length(amenities, 1) > 0
  `;
  if (orgRows.length === 0) {
    console.log("No units with legacy amenity slugs — nothing to do.");
    return;
  }

  for (const { organizationId } of orgRows) {
    console.log(`Org ${organizationId}:`);

    const distinctSlugs = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT DISTINCT unnest(amenities) AS slug
        FROM "Unit"
       WHERE "organizationId" = ${organizationId}::uuid
         AND array_length(amenities, 1) > 0
    `;

    // Already-UUID values are valid catalog references; leave them.
    const legacySlugs = distinctSlugs
      .map((r) => r.slug)
      .filter((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));

    const slugToId = new Map<string, string>();
    const existing = await prisma.amenity.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const existingByLowerName = new Map(existing.map((a) => [a.name.toLowerCase(), a.id]));

    for (const slug of legacySlugs) {
      const displayName = SLUG_DISPLAY[slug] ?? slug;
      const existingId = existingByLowerName.get(displayName.toLowerCase());
      if (existingId) {
        slugToId.set(slug, existingId);
        console.log(`  reused "${displayName}" → ${existingId}`);
        continue;
      }
      const created = await prisma.amenity.create({
        data: { organizationId, name: displayName, isActive: true },
        select: { id: true },
      });
      slugToId.set(slug, created.id);
      console.log(`  created "${displayName}" → ${created.id}`);
    }

    const units = await prisma.unit.findMany({
      where: { organizationId, amenities: { isEmpty: false } },
      select: { id: true, unitCode: true, amenities: true },
    });

    let touched = 0;
    for (const u of units) {
      const next = u.amenities.map((s) => slugToId.get(s) ?? s);
      const changed =
        next.length !== u.amenities.length || next.some((v, i) => v !== u.amenities[i]);
      if (!changed) continue;
      await prisma.unit.update({
        where: { id: u.id },
        data: { amenities: next },
      });
      touched += 1;
    }
    console.log(`  rewrote amenities on ${touched} unit(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
