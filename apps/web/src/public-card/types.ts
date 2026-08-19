// Public e-namecard DTO — type-only mirror of the canonical interface in
// `apps/api/src/modules/public-card/dto.ts`. Kept in sync by hand because the
// public bundle MUST NOT depend on `@kason/db` (Prisma types) per spec §7.3
// (separate Vite entry, minimal bundle for unauthenticated visitors).
//
// If the API DTO shape changes, update this file and the leak-guard snapshot
// test in apps/api/src/modules/public-card/__tests__/dto-leak-guard.test.ts.

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
