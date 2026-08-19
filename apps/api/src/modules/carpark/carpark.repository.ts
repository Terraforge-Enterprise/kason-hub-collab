import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

export const CARPARK_SELECT = {
  id: true, label: true, monthlyRate: true, status: true,
  apartmentId: true, propertyId: true, ownerPartyId: true,
  ownerParty: { select: { displayName: true } },
} satisfies Prisma.CarparkSelect;

/**
 * A new bay is born `status: "available"` (schema.prisma) — i.e. ACTIVE — and an
 * active bay is an inheritance source for `resolveApartmentOwnerPartyId`. Its owner
 * must therefore be derived by exactly that resolver's rule, or a bay minted on an
 * apartment whose only owned listing is ARCHIVED would be born holding that
 * archived listing's STALE owner and immediately hand it to the next new room.
 *
 * `listingStatus` is a non-nullable String, so `{ not: "archived" }` is NULL-safe.
 * `ownerPartyId` IS nullable — keep `{ not: null }` (Prisma's `{ not: x }` drops
 * NULL rows, which is precisely what selects an owned row here).
 */
export async function findApartmentForCarpark(orgId: string, apartmentId: string) {
  return getDb().apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: {
      id: true,
      propertyId: true,
      listings: {
        where: {
          ownerPartyId: { not: null },
          listingStatus: { not: "archived" }, // archived listings hold STALE owners
        },
        select: { ownerPartyId: true },
        orderBy: { id: "asc" }, // `take: 1` without an orderBy is nondeterministic
        take: 1,
      },
    },
  });
}

export async function findCarparkById(orgId: string, id: string) {
  return getDb().carpark.findFirst({
    where: { id, organizationId: orgId },
    select: { ...CARPARK_SELECT, id: true },
  });
}

export async function listCarparksByApartment(orgId: string, apartmentId: string) {
  return getDb().carpark.findMany({
    where: { organizationId: orgId, apartmentId, status: { not: "inactive" } },
    select: CARPARK_SELECT,
    orderBy: { label: "asc" },
  });
}

export async function listAvailableCarparksByProperty(orgId: string, propertyId: string) {
  return getDb().carpark.findMany({
    where: { organizationId: orgId, propertyId, status: "available" },
    select: CARPARK_SELECT,
    orderBy: { label: "asc" },
  });
}

export async function countActiveAssignments(orgId: string, carparkId: string) {
  return getDb().carparkAssignment.count({
    where: { organizationId: orgId, carparkId, status: "active" },
  });
}

/** Load a tenancy for carpark assignment validation (propertyId match). */
export async function findTenancyForCarparkAssignment(orgId: string, tenancyId: string) {
  return getDb().tenancy.findFirst({
    where: { id: tenancyId, organizationId: orgId },
    select: { id: true, propertyId: true, tenantPartyId: true, status: true },
  });
}

/** Find a single ACTIVE carpark assignment (used by the single-release service). */
export async function findCarparkAssignmentById(orgId: string, assignmentId: string) {
  return getDb().carparkAssignment.findFirst({
    where: { id: assignmentId, organizationId: orgId, status: "active" },
    select: { id: true, carparkId: true, tenancyId: true },
  });
}
