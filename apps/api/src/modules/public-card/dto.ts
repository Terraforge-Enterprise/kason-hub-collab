// DTO mapper for the public agent-card endpoint (per spec §9.4).
//
// CRITICAL — this is the ONLY allowed path from internal Prisma rows to the
// public JSON response. NEVER spread a Prisma row into the response. NEVER
// `include`-shortcut additional relations into the output. The leak-guard
// snapshot test in `__tests__/dto-leak-guard.test.ts` enforces this at CI.
//
// Field-name reconciliation against the real `Unit` schema
// (`packages/db/prisma/schema.prisma:204`):
//   spec field     → schema field
//   address        → publishedTitle ?? unitCode  (no `address` column on Unit)
//   type           → unitType
//   bedrooms       → bedrooms
//   bathrooms      → bathrooms       (Prisma Decimal; .toNumber() on map)
//   sizeSqft       → sizeSqft        (Prisma Decimal; .toNumber() on map)

import type { Prisma } from "@kason/db";

type Decimal = Prisma.Decimal;

// Local row shapes — intentionally hand-typed instead of importing the full
// Prisma model types. This way the DTO mapper's input is a tiny, explicit
// surface; if Prisma adds new columns we don't accidentally pick them up.

export interface PublicCardListing {
  id: string;
  addressLine: string;
  type: string;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqft: number | null;
}

export interface PublicCardOrg {
  agencyName: string | null;
  agencyLicense: string | null;
  agencyPhone: string | null;
  agencyFax: string | null;
  address: string[];
  logoUrl: string;
}

export interface PublicCardDto {
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  whatsappPhone: string | null;
  org: PublicCardOrg;
  listings: PublicCardListing[];
  expiresAt: string | null;
}

export const PUBLIC_CARD_DTO_KEYS = [
  "displayName",
  "title",
  "primaryEmail",
  "primaryPhone",
  "whatsappPhone",
  "org",
  "listings",
  "expiresAt",
] as const;

export const PUBLIC_CARD_ORG_KEYS = [
  "agencyName",
  "agencyLicense",
  "agencyPhone",
  "agencyFax",
  "address",
  "logoUrl",
] as const;

export const PUBLIC_CARD_LISTING_KEYS = [
  "id",
  "addressLine",
  "type",
  "bedrooms",
  "bathrooms",
  "sizeSqft",
] as const;

// AgentCardVersion fields used on the card. ONLY these four are display
// data; everything else (publicToken, status, partyId, organizationId,
// reviewedById, etc.) MUST stay internal.
interface VersionInput {
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  expiresAt: Date | null;
}

interface PartyInput {
  // Read LIVE from Party.whatsappPhone, NOT from a snapshot (per spec §6.3).
  whatsappPhone: string | null;
}

interface OrgSettingsInput {
  agencyName: string | null;
  agencyLicense: string | null;
  agencyPhone: string | null;
  agencyFax: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  addressLine4: string | null;
}

// Listing input — hand-typed against the actual `Unit` schema. `bathrooms`
// and `sizeSqft` come from Prisma as Decimal | null; a number is also
// accepted for ergonomic test fixtures.
interface ListingInput {
  id: string;
  unitCode: string;
  publishedTitle: string | null;
  unitType: string;
  bedrooms: number | null;
  bathrooms: Decimal | number | null;
  sizeSqft: Decimal | number | null;
}

interface MapInput {
  version: VersionInput;
  party: PartyInput;
  org: OrgSettingsInput;
  listings: ListingInput[];
}

function decimalToNumber(value: Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Prisma Decimal exposes toNumber()
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

export function toPublicCardDto({
  version,
  party,
  org,
  listings,
}: MapInput): PublicCardDto {
  return {
    displayName: version.displayName,
    title: version.title,
    primaryEmail: version.primaryEmail,
    primaryPhone: version.primaryPhone,
    whatsappPhone: party.whatsappPhone,
    org: {
      agencyName: org.agencyName,
      agencyLicense: org.agencyLicense,
      agencyPhone: org.agencyPhone,
      agencyFax: org.agencyFax,
      address: [
        org.addressLine1,
        org.addressLine2,
        org.addressLine3,
        org.addressLine4,
      ].filter((l): l is string => Boolean(l && l.trim())),
      logoUrl: "/logo-gold.png",
    },
    listings: listings.map((u) => ({
      id: u.id,
      addressLine: u.publishedTitle ?? u.unitCode ?? "",
      type: u.unitType ?? "",
      bedrooms: u.bedrooms ?? null,
      bathrooms: decimalToNumber(u.bathrooms),
      sizeSqft: decimalToNumber(u.sizeSqft),
    })),
    expiresAt: version.expiresAt ? version.expiresAt.toISOString() : null,
  };
}
