import type { Prisma } from "@kason/db";

export type BlockerKind =
  | "any-reservations"
  | "any-tenancy"
  | "non-zero-charges"
  | "any-deposit";

export type CascadeKind = "unit-attributes" | "listing-visibility-grants";

export interface DeletionBlocker {
  kind: BlockerKind;
  count: number;
  sampleIds: string[];
  resolveHref: string;
  resolveLabel: string;
}

export interface DeletionCascade {
  kind: CascadeKind;
  count: number;
}

export interface DeletionReport {
  unitId: string;
  unitCode: string;
  unitLabel: string;
  canDelete: boolean;
  blockers: DeletionBlocker[];
  cascades: DeletionCascade[];
}

// Listing here means the Prisma model that maps to the physical `Unit`
// table (@@map("Unit")). FK columns on child rows still carry the legacy
// `unitId` name — the rename is in the application layer only.
type ReadClient = Pick<
  Prisma.TransactionClient,
  | "listing"
  | "unitReservation"
  | "tenancy"
  | "charge"
  | "deposit"
  | "unitAttribute"
  | "listingVisibilityGrant"
>;

const SAMPLE_LIMIT = 5;

export async function buildDeletionPreview(
  client: ReadClient,
  organizationId: string,
  unitId: string,
): Promise<DeletionReport | null> {
  const listing = await client.listing.findFirst({
    where: { id: unitId, organizationId },
    select: {
      id: true,
      apartment: {
        select: {
          unitCode: true,
          property: { select: { name: true } },
        },
      },
    },
  });
  if (!listing) return null;

  const unitCode = listing.apartment.unitCode;
  const propertyName = listing.apartment.property?.name;

  const unitLabel = [propertyName, unitCode].filter(Boolean).join(", ");

  // Cascade scope is unchanged: the Apartment row is NOT removed when its
  // last Listing is deleted (apartment cleanup is a follow-up). Child FK
  // columns still reference Listing.id via the legacy `unitId` name.
  const [
    reservationCount,
    tenancyCount,
    chargeCount,
    depositCount,
    attributeCount,
    grantCount,
  ] = await Promise.all([
    client.unitReservation.count({ where: { organizationId, unitId } }),
    client.tenancy.count({ where: { organizationId, unitId } }),
    client.charge.count({ where: { organizationId, unitId } }),
    client.deposit.count({ where: { organizationId, unitId } }),
    client.unitAttribute.count({ where: { unitId } }),
    client.listingVisibilityGrant.count({ where: { unitId } }),
  ]);

  const blockers: DeletionBlocker[] = [];

  if (reservationCount > 0) {
    const samples = await client.unitReservation.findMany({
      where: { organizationId, unitId },
      select: { id: true },
      take: SAMPLE_LIMIT,
    });
    blockers.push({
      kind: "any-reservations",
      count: reservationCount,
      sampleIds: samples.map((s) => s.id),
      resolveHref: `/reservations?unitId=${unitId}`,
      resolveLabel: `View ${reservationCount} reservation${reservationCount === 1 ? "" : "s"}`,
    });
  }

  if (tenancyCount > 0) {
    const samples = await client.tenancy.findMany({
      where: { organizationId, unitId },
      select: { id: true },
      take: SAMPLE_LIMIT,
    });
    blockers.push({
      kind: "any-tenancy",
      count: tenancyCount,
      sampleIds: samples.map((s) => s.id),
      resolveHref: `/tenancies?unitId=${unitId}`,
      resolveLabel: `View ${tenancyCount} tenancy record${tenancyCount === 1 ? "" : "s"}`,
    });
  }

  if (chargeCount > 0) {
    const samples = await client.charge.findMany({
      where: { organizationId, unitId },
      select: { id: true },
      take: SAMPLE_LIMIT,
    });
    blockers.push({
      kind: "non-zero-charges",
      count: chargeCount,
      sampleIds: samples.map((s) => s.id),
      resolveHref: `/charges?unitId=${unitId}`,
      resolveLabel: `View ${chargeCount} charge${chargeCount === 1 ? "" : "s"}`,
    });
  }

  if (depositCount > 0) {
    const samples = await client.deposit.findMany({
      where: { organizationId, unitId },
      select: { id: true },
      take: SAMPLE_LIMIT,
    });
    blockers.push({
      kind: "any-deposit",
      count: depositCount,
      sampleIds: samples.map((s) => s.id),
      resolveHref: `/deposits?unitId=${unitId}`,
      resolveLabel: `View ${depositCount} deposit${depositCount === 1 ? "" : "s"}`,
    });
  }

  const cascades: DeletionCascade[] = [
    { kind: "unit-attributes", count: attributeCount },
    { kind: "listing-visibility-grants", count: grantCount },
  ];

  return {
    unitId: listing.id,
    unitCode,
    unitLabel,
    canDelete: blockers.length === 0,
    blockers,
    cascades,
  };
}
