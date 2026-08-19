import { getDb } from "@kason/db";

export type ListingMode = "WHOLE" | "PARTITIONED" | "MIXED" | null;

/**
 * Compute a derived "unit group" listing-mode by inspecting active (non-archived)
 * Listings on a given Apartment (matched by org + propertyId + unitCode). Used
 * by createUnitService / updateUnitService as the legacy kind-mismatch guard.
 *
 * Note on the parent table: the new schema keeps `listingMode` directly on
 * Apartment as an enum column. This helper continues to compute it from
 * Listing rows + RoomType.kind so the kind-mismatch guard works even if the
 * Apartment row hasn't been flipped yet (legacy data). For new code, prefer
 * reading Apartment.listingMode directly.
 */
export async function getUnitGroupMode(
  orgId: string,
  propertyId: string,
  unitCode: string,
): Promise<ListingMode> {
  const db = getDb();
  const siblings = await db.listing.findMany({
    where: {
      organizationId: orgId,
      listingStatus: { not: "archived" },
      apartment: { propertyId, unitCode },
    },
    select: { listingType: true },
  });
  if (siblings.length === 0) return null;

  const types = [...new Set(siblings.map((s) => s.listingType))];
  const rooms = await db.roomType.findMany({
    where: { organizationId: orgId, name: { in: types } },
    select: { name: true, kind: true },
  });
  const kindByName = new Map(rooms.map((r) => [r.name, r.kind as "WHOLE" | "PARTITION"]));
  const kinds = new Set<"WHOLE" | "PARTITION">();
  for (const t of types) {
    const k = kindByName.get(t);
    if (k) kinds.add(k);
  }
  if (kinds.size === 0) return null; // unknown listingType strings — treat as no info
  if (kinds.size > 1) return "MIXED";
  return kinds.has("WHOLE") ? "WHOLE" : "PARTITIONED";
}

export async function resolveRoomTypeKind(
  orgId: string,
  unitTypeName: string,
): Promise<"WHOLE" | "PARTITION" | null> {
  const db = getDb();
  const rt = await db.roomType.findFirst({
    where: { organizationId: orgId, name: unitTypeName },
    select: { kind: true },
  });
  return (rt?.kind as "WHOLE" | "PARTITION" | undefined) ?? null;
}
