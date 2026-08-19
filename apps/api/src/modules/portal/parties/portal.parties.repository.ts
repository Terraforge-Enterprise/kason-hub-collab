import { getDb } from "@kason/db";

// Owner search/create scoped to the portal-side agent.
//
// Schema verified in packages/db/prisma/schema.prisma:
//   - Party.partyType is the discriminator ("owner" for owners).
//   - Party.salesUnitsOwned is the back-relation to SalesUnit where this
//     Party is the owner (relation name "SalesUnitOwner",
//     SalesUnit.ownerPartyId → Party.id).
//   - SalesUnit.agentPartyId identifies the submitting agent — that is the
//     scoping key the portal uses to confine owner visibility to "owners
//     this agent has previously referenced".

export const portalPartiesRepository = () => ({
  searchOwnersForAgent: async (orgId: string, agentPartyId: string, q: string) => {
    const db = getDb();
    const rows = await db.party.findMany({
      where: {
        organizationId: orgId,
        partyType: "owner",
        OR: [
          { displayName: { contains: q, mode: "insensitive" } },
          { primaryPhone: { contains: q } },
          { primaryEmail: { contains: q, mode: "insensitive" } },
        ],
        salesUnitsOwned: {
          some: { agentPartyId },
        },
      },
      select: { id: true, displayName: true, primaryPhone: true, primaryEmail: true },
      take: 10,
      orderBy: { displayName: "asc" },
    });
    return rows;
  },
  findOwnerByIdForAgent: (orgId: string, agentPartyId: string, id: string) => {
    const db = getDb();
    return db.party.findFirst({
      where: {
        id,
        organizationId: orgId,
        partyType: "owner",
        salesUnitsOwned: { some: { agentPartyId } },
      },
      select: { id: true, displayName: true, primaryPhone: true, primaryEmail: true },
    });
  },
  createOwner: async (input: {
    orgId: string;
    displayName: string;
    primaryPhone?: string;
    primaryEmail?: string;
    partyType: "owner";
  }) => {
    const db = getDb();
    return db.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: {
          organizationId: input.orgId,
          displayName: input.displayName,
          primaryPhone: input.primaryPhone ?? null,
          primaryEmail: input.primaryEmail ?? null,
          partyType: input.partyType,
          status: "active",
        },
        select: { id: true, displayName: true, primaryPhone: true, primaryEmail: true },
      });
      await tx.partyRole.create({
        data: {
          organizationId: input.orgId,
          partyId: party.id,
          roleType: "owner",
          status: "active",
        },
      });
      return party;
    });
  },
});
