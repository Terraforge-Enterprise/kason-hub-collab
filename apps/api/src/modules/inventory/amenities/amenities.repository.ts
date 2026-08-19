import { getDb } from "@kason/db";

export type AmenityRow = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function listAmenitiesRepo(orgId: string, opts?: { activeOnly?: boolean }): Promise<AmenityRow[]> {
  return getDb().amenity.findMany({
    where: {
      organizationId: orgId,
      ...(opts?.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function findAmenityById(orgId: string, id: string): Promise<AmenityRow | null> {
  return getDb().amenity.findFirst({ where: { id, organizationId: orgId } });
}

export async function createAmenityRow(orgId: string, input: { name: string; sortOrder: number }): Promise<AmenityRow> {
  return getDb().amenity.create({
    data: { organizationId: orgId, name: input.name, sortOrder: input.sortOrder },
  });
}

export async function updateAmenityRow(
  orgId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<AmenityRow | null> {
  const existing = await findAmenityById(orgId, id);
  if (!existing) return null;
  return getDb().amenity.update({ where: { id }, data: input });
}

export async function deleteAmenityRow(orgId: string, id: string): Promise<{ affectedUnitCount: number }> {
  // Atomic: delete the amenity AND strip its ID from every apartment's
  // amenities[] array in the same transaction. amenities live on Apartment
  // (not Listing) post-refactor; the affectedUnitCount field name is
  // retained for back-compat with the wire shape.
  return getDb().$transaction(async (tx) => {
    const existing = await tx.amenity.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) return { affectedUnitCount: 0 };

    // Count apartments that reference this amenity BEFORE the strip.
    const affected = await tx.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "Apartment" WHERE "organizationId" = $1::uuid AND $2 = ANY(amenities)`,
      orgId,
      id,
    );
    const affectedUnitCount = Number(affected[0]?.count ?? 0);

    // Strip the ID from every apartment's amenities[] array.
    await tx.$executeRawUnsafe(
      `UPDATE "Apartment" SET amenities = array_remove(amenities, $2) WHERE "organizationId" = $1::uuid AND $2 = ANY(amenities)`,
      orgId,
      id,
    );

    // Delete the catalog row.
    await tx.amenity.delete({ where: { id } });

    return { affectedUnitCount };
  });
}

export async function getAmenityUsageRepo(
  orgId: string,
  id: string,
): Promise<{ count: number; units: { id: string; unitCode: string; propertyName: string }[] }> {
  // Amenities live on Apartment post-refactor — count + preview run against
  // Apartment rows. The response field name `units` is kept stable for the
  // SPA which displays one entry per apartment.
  const countRow = await getDb().$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "Apartment" WHERE "organizationId" = $1::uuid AND $2 = ANY(amenities)`,
    orgId,
    id,
  );
  const count = Number(countRow[0]?.count ?? 0);

  const apartments = await getDb().apartment.findMany({
    where: {
      organizationId: orgId,
      amenities: { has: id },
    },
    select: {
      id: true,
      unitCode: true,
      property: { select: { name: true } },
    },
    orderBy: { unitCode: "asc" },
    take: 100,
  });

  return {
    count,
    units: apartments.map((a) => ({
      id: a.id,
      unitCode: a.unitCode,
      propertyName: a.property?.name ?? "(unknown)",
    })),
  };
}

// The Amenity.id column is a Postgres uuid. Only uuid-shaped tokens can be
// catalog ids, so only those may be fed to `id: { in: [...] }`.
const AMENITY_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function assertAmenitiesBelongToOrgRepo(
  orgId: string,
  amenityIds: string[],
): Promise<{ ok: true } | { ok: false; missingIds: string[] }> {
  if (amenityIds.length === 0) return { ok: true };
  // Gate ONLY uuid-shaped tokens for cross-org ownership. Legacy
  // Apartment.amenities rows can still carry pre-catalog free-string slugs
  // ("pool", "gym"); passing those into the uuid `id IN (...)` query makes
  // Postgres throw `invalid input syntax for type uuid` (Prisma P2023), which
  // used to escape as a 500 on the inventory batch / create / edit paths.
  // Non-uuid tokens are pass-through: never queried, never rejected.
  const uuidIds = amenityIds.filter((id) => AMENITY_UUID_RE.test(id));
  if (uuidIds.length === 0) return { ok: true };
  const rows = await getDb().amenity.findMany({
    where: { organizationId: orgId, id: { in: uuidIds } },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missingIds = uuidIds.filter((id) => !found.has(id));
  return missingIds.length === 0 ? { ok: true } : { ok: false, missingIds };
}
