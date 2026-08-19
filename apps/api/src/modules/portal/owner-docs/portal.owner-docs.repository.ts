import { getDb } from "@kason/db";

type SessionScope = { partyId: string; orgId: string };

export async function getOwnerDocuments(session: SessionScope) {
  const db = getDb();

  // Owner → properties resolved per-unit via Listing.ownerPartyId (owner money is
  // attributed per-unit, NOT per-property via LandlordTenancy). Documents linked to
  // any property the owner owns ≥1 non-archived listing in are visible.
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId: session.partyId,
      organizationId: session.orgId,
      listingStatus: { not: "archived" },
    },
    select: { apartment: { select: { propertyId: true } } },
  });

  const propertyIds = [...new Set(ownedListings.map((l) => l.apartment.propertyId))];

  const docs = await db.document.findMany({
    where: {
      organizationId: session.orgId,
      OR: [
        { links: { some: { linkedEntityType: "party", linkedEntityId: session.partyId } } },
        { links: { some: { linkedEntityType: "property", linkedEntityId: { in: propertyIds } } } },
      ],
    },
    select: {
      id: true,
      fileName: true,
      fileType: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return docs.map((d) => ({
    id: d.id,
    title: d.fileName,
    fileType: d.fileType,
    createdAt: d.createdAt.toISOString(),
  }));
}
