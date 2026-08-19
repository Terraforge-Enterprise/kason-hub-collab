// Service layer for the public agent-card endpoint (per spec §6.3, §9.4 #14).
//
// Single export: `getPublicCardByToken(token)`. Returns the projected DTO on
// the happy path, and `null` for ANY failure of the validation/status chain.
// The route layer maps `null` → identical 404 (body + minimum 50ms timing)
// to prevent token-existence side-channel leaks.
//
// Status chain (any single failure → null):
//   1. Token shape passes /^[A-Za-z0-9_-]{22}$/  (rejected before the DB)
//   2. AgentCardVersion exists with publicToken=token
//   3. version.status = 'approved'
//   4. version.expiresAt > NOW
//   5. version.party.status = 'active'
//   6. version.party.organization.status = 'active'
//   7. version.party.organization.cardSettings exists
//
// All reads go through `getReadOnlyPrisma()` — the Postgres role for that
// connection has SELECT on (AgentCardVersion, Party, Organization,
// OrganizationCardSettings, Unit) and nothing else.

import { getReadOnlyPrisma } from "./prisma-readonly";
import { toPublicCardDto, type PublicCardDto } from "./dto";

const TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

export async function getPublicCardByToken(
  token: string,
): Promise<PublicCardDto | null> {
  // Step 1 — fail fast on token shape. Linear-time, anchored regex; no ReDoS.
  if (typeof token !== "string" || !TOKEN_REGEX.test(token)) return null;

  const prisma = getReadOnlyPrisma();

  // Steps 2-4 — single round-trip with the relations we need for steps 5-7.
  // `findFirst` (not `findUnique`) lets us combine status + expiresAt in the
  // WHERE so the DB does the gating, not the app.
  const version = await prisma.agentCardVersion.findFirst({
    where: {
      publicToken: token,
      status: "approved",
      expiresAt: { gt: new Date() },
    },
    include: {
      party: {
        include: {
          organization: {
            include: { cardSettings: true },
          },
        },
      },
    },
  });

  if (!version) return null;

  // Steps 5-7 — defence-in-depth status checks. The findFirst above already
  // enforces approved+unexpired; here we enforce the relational guards.
  const party = version.party;
  if (!party || party.status !== "active") return null;

  const org = party.organization;
  if (!org || org.status !== "active") return null;

  const cardSettings = org.cardSettings;
  if (!cardSettings) return null;

  // Listings query — show active units that this agent can legitimately
  // promote on their card:
  //   (a) units this agent IS in-charge of  (their own listings), AND
  //   (b) units with NO in-charge agent     (admin/KAEN-managed pool).
  // EXCLUDES units assigned to OTHER agents — the card must not poach
  // another agent's listing. The org boundary is also enforced as defence
  // in depth (cross-org leak impossible at the SQL level).
  // `select` (not `include`) keeps the data surface tiny.
  const rawListings = await prisma.listing.findMany({
    where: {
      organizationId: party.organizationId,
      listingStatus: "active",
      OR: [
        { inChargePartyId: party.id },
        { inChargePartyId: null },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      listingType: true,
      apartment: {
        select: {
          unitCode: true,
          publishedTitle: true,
          bedrooms: true,
          bathrooms: true,
          floorArea: true,
        },
      },
    },
  });

  // Shared apartment fields (publishedTitle, bedrooms, bathrooms, floorArea)
  // now live on Apartment after the three-table refactor. Flatten back to the
  // DTO mapper's expected listing shape.
  const listings = rawListings.map((l) => ({
    id: l.id,
    unitCode: l.apartment.unitCode,
    publishedTitle: l.apartment.publishedTitle,
    unitType: l.listingType,
    bedrooms: l.apartment.bedrooms ?? null,
    bathrooms: l.apartment.bathrooms,
    sizeSqft: l.apartment.floorArea,
  }));

  return toPublicCardDto({
    version: {
      displayName: version.displayName,
      title: version.title,
      primaryEmail: version.primaryEmail,
      primaryPhone: version.primaryPhone,
      expiresAt: version.expiresAt,
    },
    party: { whatsappPhone: party.whatsappPhone },
    org: {
      agencyName: cardSettings.agencyName,
      agencyLicense: cardSettings.agencyLicense,
      agencyPhone: cardSettings.agencyPhone,
      agencyFax: cardSettings.agencyFax,
      addressLine1: cardSettings.addressLine1,
      addressLine2: cardSettings.addressLine2,
      addressLine3: cardSettings.addressLine3,
      addressLine4: cardSettings.addressLine4,
    },
    listings,
  });
}
