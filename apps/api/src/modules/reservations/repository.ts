// apps/api/src/modules/reservations/repository.ts

import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

const include = {
  property: { select: { id: true, name: true } },
  unit: {
    select: { id: true, apartment: { select: { unitCode: true } } },
  },
  documents: {
    select: { id: true, kind: true, filename: true, uploadedAt: true },
    orderBy: { kind: "asc" as const },
  },
} as const;

// Post three-table refactor: `unitCode` lives on Apartment, reached via
// listing.apartment.unitCode. We flatten that back to `unit.unitCode` so the
// rest of the reservations service and the JSON contract are unchanged.
// UnitReservation.unitId is NOT NULL in the schema, so `unit` is always
// present on a hydrated row.
function flattenUnit<T extends { unit: { id: string; apartment: { unitCode: string } } }>(
  row: T,
): Omit<T, "unit"> & { unit: { id: string; unitCode: string } } {
  return {
    ...row,
    unit: { id: row.unit.id, unitCode: row.unit.apartment.unitCode },
  };
}

export async function findByTokenForPublicReadOnly(token: string, prisma: ReturnType<typeof getDb>) {
  const row = await prisma.unitReservation.findFirst({
    where: { publicToken: token },
    include,
  });
  return row ? flattenUnit(row) : null;
}

export async function findByIdInOrg(orgId: string, id: string) {
  const row = await getDb().unitReservation.findFirst({
    where: { organizationId: orgId, id },
    include,
  });
  return row ? flattenUnit(row) : null;
}

export async function listForOrg(orgId: string, status?: string) {
  const rows = await getDb().unitReservation.findMany({
    where: { organizationId: orgId, ...(status ? { status } : {}) },
    include,
    orderBy: { issuedAt: "desc" },
  });
  return rows.map(flattenUnit);
}

export async function listForAgent(orgId: string, agentPartyId: string) {
  const rows = await getDb().unitReservation.findMany({
    where: { organizationId: orgId, issuedByPartyId: agentPartyId },
    include,
    orderBy: { issuedAt: "desc" },
  });
  return rows.map(flattenUnit);
}

export async function insertTransitionTx(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    reservationId: string;
    fromStatus: string | null;
    toStatus: string;
    actor: string;
    note?: string;
  },
) {
  await tx.unitReservationTransition.create({
    data: {
      organizationId: args.orgId,
      reservationId: args.reservationId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      actor: args.actor,
      note: args.note,
    },
  });
}

export type EligibleUnitForReservation = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  sourcingAgentId: string | null;
  inChargePartyId: string | null;
  property: { id: string; name: string; propertyCode: string };
};

export async function findReadyNowActiveUnitsInOrg(
  orgId: string,
): Promise<EligibleUnitForReservation[]> {
  const rows = await getDb().listing.findMany({
    where: { organizationId: orgId, listingStatus: "active", readyNow: true },
    select: {
      id: true,
      listingType: true,
      visibilityMode: true,
      hiddenFromPartyIds: true,
      sourcingAgentId: true,
      inChargePartyId: true,
      apartment: {
        select: {
          unitCode: true,
          bedrooms: true,
          property: { select: { id: true, name: true, propertyCode: true } },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    unitCode: r.apartment.unitCode,
    unitType: r.listingType,
    bedrooms: r.apartment.bedrooms,
    visibilityMode: r.visibilityMode,
    hiddenFromPartyIds: r.hiddenFromPartyIds,
    sourcingAgentId: r.sourcingAgentId,
    inChargePartyId: r.inChargePartyId,
    property: r.apartment.property,
  }));
}

// Shared select shape for both pickable/linked-reservation lookups so
// toPickableReservationDto (service.ts) can map either row shape through the
// exact same code path.
const pickableSelect = {
  id: true,
  referenceCode: true,
  proposedMoveIn: true,
  proposedMoveOut: true,
  agreedMonthlyRent: true,
  applicantFullName: true,
  applicantNric: true,
  applicantContact: true,
  applicantEmail: true,
  unit: {
    select: { id: true, listingType: true, apartment: { select: { unitCode: true } } },
  },
} as const;

// Picker source for tenant-create-from-reservation (T3/T5+). Only reservations
// that are SIGNED and not yet linked to a tenant Party are pickable — once
// tenantPartyId is set, the reservation has already been consumed to create a
// tenancy and must drop out of the picker.
export async function listPickableReservations(orgId: string) {
  return getDb().unitReservation.findMany({
    where: { organizationId: orgId, status: "signed", tenantPartyId: null },
    select: pickableSelect,
    orderBy: { createdAt: "desc" },
  });
}

// The tenant-driven derive source (T13/R5): the signed, not-yet-converted
// reservation linked to a SPECIFIC tenant Party (tenantPartyId is set at
// tenant-create-from-reservation, parties.service.ts). `tenancy: { is: null }`
// excludes a reservation that has already been converted into a Tenancy —
// tenantPartyId is never cleared on convert, so status/tenantPartyId alone
// can't tell "already used" apart from "still derivable".
export async function findLinkedSignedReservation(orgId: string, tenantPartyId: string) {
  return getDb().unitReservation.findFirst({
    where: { organizationId: orgId, tenantPartyId, status: "signed", tenancy: { is: null } },
    select: pickableSelect,
    orderBy: { signedAt: "desc" },
  });
}

export async function findAgentVisibilityGrants(orgId: string, agentPartyId: string) {
  return getDb().listingVisibilityGrant.findMany({
    where: { organizationId: orgId, partyId: agentPartyId },
    select: { unitId: true },
  });
}

export type UnitEligibilityFields = {
  propertyId: string;
  listingStatus: string;
  readyNow: boolean;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  sourcingAgentId: string | null;
  inChargePartyId: string | null;
  ownerPartyId: string | null;
};

export async function findUnitEligibilityFields(
  orgId: string,
  unitId: string,
): Promise<UnitEligibilityFields | null> {
  const listing = await getDb().listing.findFirst({
    where: { id: unitId, organizationId: orgId },
    select: {
      listingStatus: true,
      readyNow: true,
      visibilityMode: true,
      hiddenFromPartyIds: true,
      sourcingAgentId: true,
      inChargePartyId: true,
      ownerPartyId: true,
      apartment: { select: { propertyId: true } },
    },
  });
  if (!listing) return null;
  return {
    propertyId: listing.apartment.propertyId,
    listingStatus: listing.listingStatus,
    readyNow: listing.readyNow,
    visibilityMode: listing.visibilityMode,
    hiddenFromPartyIds: listing.hiddenFromPartyIds,
    sourcingAgentId: listing.sourcingAgentId,
    inChargePartyId: listing.inChargePartyId,
    ownerPartyId: listing.ownerPartyId,
  };
}
