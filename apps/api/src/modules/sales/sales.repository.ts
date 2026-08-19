import { getDb, Prisma } from "@kason/db";
import type {
  CreateSalesUnitInput,
  ListSalesUnitsQuery,
  RenovationProgressRow,
  RenovationTransitionRow,
  SalesUnitRow,
  UpdateSalesUnitInput,
} from "./sales.types";

const SALES_UNIT_SELECT = {
  id: true,
  organizationId: true,
  projectId: true,
  unitNumber: true,
  ownerPartyId: true,
  salesDate: true,
  purpose: true,
  bedrooms: true,
  bathrooms: true,
  parkingLots: true,
  expectedRental: true,
  purchasePrice: true,
  agentPartyId: true,
  inChargePartyId: true,
  sourceFlag: true,
  sourcingApproved: true,
  sourcingApprovedById: true,
  sourcingApprovedAt: true,
  amendmentNotes: true,
  promotedUnitId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

type RawSalesUnit = {
  id: string;
  organizationId: string;
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: Date;
  purpose: string;
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental: Prisma.Decimal | null;
  purchasePrice: Prisma.Decimal;
  agentPartyId: string;
  inChargePartyId: string | null;
  sourceFlag: string;
  sourcingApproved: boolean;
  sourcingApprovedById: string | null;
  sourcingApprovedAt: Date | null;
  amendmentNotes: string | null;
  promotedUnitId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapSalesUnit(row: RawSalesUnit): SalesUnitRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    unitNumber: row.unitNumber,
    ownerPartyId: row.ownerPartyId,
    salesDate: row.salesDate,
    purpose: row.purpose as "rent" | "own_stay",
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parkingLots: row.parkingLots,
    expectedRental: decToNumber(row.expectedRental),
    purchasePrice: decToNumber(row.purchasePrice) ?? 0,
    agentPartyId: row.agentPartyId,
    inChargePartyId: row.inChargePartyId,
    sourceFlag: row.sourceFlag,
    sourcingApproved: row.sourcingApproved,
    sourcingApprovedById: row.sourcingApprovedById,
    sourcingApprovedAt: row.sourcingApprovedAt,
    amendmentNotes: row.amendmentNotes,
    promotedUnitId: row.promotedUnitId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSalesUnits(
  organizationId: string,
  filters?: ListSalesUnitsQuery & { agentPartyIdEq?: string },
): Promise<SalesUnitRow[]> {
  const db = getDb();
  const q = filters?.q?.trim();
  const where: Prisma.SalesUnitWhereInput = {
    organizationId,
    // Withdrawn submissions soft-deleted via sourcingCancelled stay in
    // the table for audit but never appear in any admin/agent list. See
    // unified-property-sourcing spec §3.4.
    sourcingCancelled: false,
    ...(filters?.projectId ? { projectId: filters.projectId } : {}),
    ...(filters?.sourcingApproved !== undefined
      ? { sourcingApproved: filters.sourcingApproved }
      : {}),
    ...(filters?.agentPartyIdEq ? { agentPartyId: filters.agentPartyIdEq } : {}),
    ...(filters?.salesDateFrom || filters?.salesDateTo
      ? {
          salesDate: {
            ...(filters?.salesDateFrom ? { gte: new Date(filters.salesDateFrom) } : {}),
            ...(filters?.salesDateTo ? { lte: new Date(filters.salesDateTo) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { unitNumber: { contains: q, mode: "insensitive" } },
            { ownerParty: { displayName: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const rows = await db.salesUnit.findMany({
    where,
    select: SALES_UNIT_SELECT,
    orderBy: [{ salesDate: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  return (rows as unknown as RawSalesUnit[]).map(mapSalesUnit);
}

export async function findSalesUnitById(
  organizationId: string,
  id: string,
): Promise<SalesUnitRow | null> {
  const db = getDb();
  const row = await db.salesUnit.findFirst({
    where: { id, organizationId },
    select: SALES_UNIT_SELECT,
  });
  if (!row) return null;
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

export async function findSalesUnitByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<SalesUnitRow | null> {
  const row = await tx.salesUnit.findFirst({
    where: { id, organizationId },
    select: SALES_UNIT_SELECT,
  });
  if (!row) return null;
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

export async function findUnitNumberConflict(params: {
  organizationId: string;
  projectId: string;
  unitNumber: string;
  excludeId?: string;
}): Promise<{ id: string } | null> {
  const db = getDb();
  return db.salesUnit.findFirst({
    where: {
      organizationId: params.organizationId,
      projectId: params.projectId,
      unitNumber: params.unitNumber,
      ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
    },
    select: { id: true },
  });
}

export async function findProjectByIdScoped(
  organizationId: string,
  projectId: string,
): Promise<{ id: string; status: string; promotedPropertyId: string | null; name: string; developer: string; city: string | null } | null> {
  const db = getDb();
  return db.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true, status: true, promotedPropertyId: true, name: true, developer: true, city: true },
  });
}

export type CreateSalesUnitDbInput = CreateSalesUnitInput & {
  organizationId: string;
  agentPartyId: string;
  sourceFlag?: string;
  sourcingApproved?: boolean;
};

export async function createSalesUnitRow(
  tx: Prisma.TransactionClient,
  input: CreateSalesUnitDbInput,
): Promise<SalesUnitRow> {
  const row = await tx.salesUnit.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      unitNumber: input.unitNumber,
      ownerPartyId: input.ownerPartyId,
      salesDate: new Date(input.salesDate),
      purpose: input.purpose,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      parkingLots: input.parkingLots ?? 0,
      expectedRental: input.expectedRental ?? null,
      purchasePrice: input.purchasePrice,
      agentPartyId: input.agentPartyId,
      inChargePartyId: input.inChargePartyId ?? null,
      sourceFlag: input.sourceFlag ?? "AGENT_SOURCED",
      sourcingApproved: input.sourcingApproved ?? false,
    },
    select: SALES_UNIT_SELECT,
  });
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

export type UpdateSalesUnitDbInput = UpdateSalesUnitInput & {
  // post-edit rebound knobs (set by service for portal post-approval edits)
  sourcingApproved?: boolean;
  amendmentNotes?: string | null;
  sourcingApprovedById?: string | null;
  sourcingApprovedAt?: Date | null;
};

export async function updateSalesUnitRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: UpdateSalesUnitDbInput,
): Promise<SalesUnitRow> {
  const data: Prisma.SalesUnitUpdateInput = {};
  if (input.projectId !== undefined) data.project = { connect: { id: input.projectId } };
  if (input.unitNumber !== undefined) data.unitNumber = input.unitNumber;
  if (input.ownerPartyId !== undefined) data.ownerParty = { connect: { id: input.ownerPartyId } };
  if (input.salesDate !== undefined) data.salesDate = new Date(input.salesDate);
  if (input.purpose !== undefined) data.purpose = input.purpose;
  if (input.bedrooms !== undefined) data.bedrooms = input.bedrooms;
  if (input.bathrooms !== undefined) data.bathrooms = input.bathrooms;
  if (input.parkingLots !== undefined) data.parkingLots = input.parkingLots;
  if (input.expectedRental !== undefined) data.expectedRental = input.expectedRental;
  if (input.purchasePrice !== undefined) data.purchasePrice = input.purchasePrice;
  if (input.inChargePartyId !== undefined) {
    data.inChargeParty = input.inChargePartyId
      ? { connect: { id: input.inChargePartyId } }
      : { disconnect: true };
  }
  if (input.sourcingApproved !== undefined) data.sourcingApproved = input.sourcingApproved;
  if (input.amendmentNotes !== undefined) data.amendmentNotes = input.amendmentNotes;
  if (input.sourcingApprovedById !== undefined) {
    // SalesUnit schema has no `sourcingApprovedBy` relation — only the
    // raw `sourcingApprovedById` Uuid column. Set it directly.
    data.sourcingApprovedById = input.sourcingApprovedById;
  }
  if (input.sourcingApprovedAt !== undefined) data.sourcingApprovedAt = input.sourcingApprovedAt;

  const row = await tx.salesUnit.update({
    where: { id, organizationId },
    data,
    select: SALES_UNIT_SELECT,
  });
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

export async function approveSourcingRow(
  tx: Prisma.TransactionClient,
  id: string,
  approverUserId: string,
  agentPartyId: string,
): Promise<SalesUnitRow> {
  const row = await tx.salesUnit.update({
    where: { id },
    data: {
      sourcingApproved: true,
      sourcingApprovedById: approverUserId,
      sourcingApprovedAt: new Date(),
      // Rule from plan: in-charge defaults to the submitting agent on approval.
      inChargePartyId: agentPartyId,
    },
    select: SALES_UNIT_SELECT,
  });
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

export async function setAmendmentNote(
  tx: Prisma.TransactionClient,
  id: string,
  note: string,
): Promise<SalesUnitRow> {
  const row = await tx.salesUnit.update({
    where: { id },
    data: { amendmentNotes: note },
    select: SALES_UNIT_SELECT,
  });
  return mapSalesUnit(row as unknown as RawSalesUnit);
}

// ─── Renovation progress ─────────────────────────────────────────────────────

const RENOVATION_PROGRESS_SELECT = {
  id: true,
  organizationId: true,
  salesUnitId: true,
  status: true,
  startDate: true,
  expectedCompletion: true,
  actualCompletion: true,
  notes: true,
  updatedAt: true,
  updatedById: true,
} as const;

export async function findRenovationProgress(
  tx: Prisma.TransactionClient,
  salesUnitId: string,
): Promise<RenovationProgressRow | null> {
  const row = await tx.renovationProgress.findUnique({
    where: { salesUnitId },
    select: RENOVATION_PROGRESS_SELECT,
  });
  if (!row) return null;
  return row as unknown as RenovationProgressRow;
}

export async function upsertRenovationProgress(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    salesUnitId: string;
    status: "not_started" | "on_going" | "completed";
    startDate?: Date | null;
    expectedCompletion?: Date | null;
    actualCompletion?: Date | null;
    notes?: string | null;
    updatedById: string;
  },
): Promise<RenovationProgressRow> {
  const dataCommon = {
    status: params.status,
    startDate: params.startDate ?? null,
    expectedCompletion: params.expectedCompletion ?? null,
    actualCompletion: params.actualCompletion ?? null,
    notes: params.notes ?? null,
    updatedById: params.updatedById,
  };
  const row = await tx.renovationProgress.upsert({
    where: { salesUnitId: params.salesUnitId },
    update: dataCommon,
    create: {
      organizationId: params.organizationId,
      salesUnitId: params.salesUnitId,
      ...dataCommon,
    },
    select: RENOVATION_PROGRESS_SELECT,
  });
  return row as unknown as RenovationProgressRow;
}

export async function appendRenovationTransition(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    progressId: string;
    fromStatus: string | null;
    toStatus: string;
    changedById: string;
    note: string | null;
  },
): Promise<RenovationTransitionRow> {
  const row = await tx.renovationTransition.create({
    data: {
      organizationId: params.organizationId,
      progressId: params.progressId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      changedById: params.changedById,
      note: params.note,
    },
    select: {
      id: true,
      organizationId: true,
      progressId: true,
      fromStatus: true,
      toStatus: true,
      changedById: true,
      changedAt: true,
      note: true,
    },
  });
  return row as RenovationTransitionRow;
}

export async function listRenovationTransitions(
  organizationId: string,
  salesUnitId: string,
): Promise<RenovationTransitionRow[]> {
  const db = getDb();
  // Tx-less read; cross-checks org via the progress row's organizationId.
  const progress = await db.renovationProgress.findFirst({
    where: { salesUnitId, organizationId },
    select: {
      id: true,
      transitions: {
        select: {
          id: true,
          organizationId: true,
          progressId: true,
          fromStatus: true,
          toStatus: true,
          changedById: true,
          changedAt: true,
          note: true,
        },
        orderBy: { changedAt: "desc" },
        take: 100,
      },
    },
  });
  if (!progress) return [];
  return progress.transitions as RenovationTransitionRow[];
}

// ─── Auto-promote helpers ────────────────────────────────────────────────────

export async function setSalesUnitPromotedUnitId(
  tx: Prisma.TransactionClient,
  salesUnitId: string,
  promotedUnitId: string,
): Promise<void> {
  await tx.salesUnit.update({
    where: { id: salesUnitId },
    data: { promotedUnitId },
    select: { id: true },
  });
}

export async function setProjectPromotedPropertyId(
  tx: Prisma.TransactionClient,
  projectId: string,
  promotedPropertyId: string,
): Promise<void> {
  await tx.project.update({
    where: { id: projectId },
    data: { promotedPropertyId },
    select: { id: true },
  });
}

export async function findOrCreatePromotedProperty(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    projectId: string;
    name: string;
    city: string | null;
  },
): Promise<{ id: string }> {
  // The unique key on Property is (organizationId, propertyCode), so we need
  // a stable code. Derive `PROJ-<projectId-prefix>` to avoid collisions
  // when two projects share a name.
  const propertyCode = `PROJ-${params.projectId.slice(0, 8).toUpperCase()}`;
  const existing = await tx.property.findFirst({
    where: { organizationId: params.organizationId, propertyCode },
    select: { id: true },
  });
  if (existing) return existing;
  const created = await tx.property.create({
    data: {
      organizationId: params.organizationId,
      name: params.name,
      propertyCode,
      propertyType: "condominium",
      addressLine1: "TBD",
      city: params.city ?? "TBD",
      country: "Malaysia",
      status: "active",
      publishStatus: "draft",
    },
    select: { id: true },
  });
  return created;
}

export async function createPromotedUnit(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    propertyId: string;
    unitCode: string;
    bedrooms: number;
    bathrooms: number;
    expectedRental: number | null;
    inChargePartyId: string | null;
    sourcingAgentId: string;
    salesUnitId: string;
  },
): Promise<{ id: string }> {
  // Three-table schema: a Listing requires an Apartment. Find-or-create the
  // apartment by (orgId, propertyId, unitCode), then attach the listing.
  // Shared physical attributes (bedrooms, bathrooms) live on Apartment.
  const mappedBedrooms = params.bedrooms === -1 ? 0 : params.bedrooms;
  let apartment = await tx.apartment.findFirst({
    where: {
      organizationId: params.organizationId,
      propertyId: params.propertyId,
      unitCode: params.unitCode,
    },
    select: { id: true },
  });
  if (!apartment) {
    apartment = await tx.apartment.create({
      data: {
        organizationId: params.organizationId,
        propertyId: params.propertyId,
        unitCode: params.unitCode,
        listingMode: "WHOLE",
        bedrooms: mappedBedrooms,
        bathrooms: params.bathrooms,
      },
      select: { id: true },
    });
  }

  const created = await tx.listing.create({
    data: {
      organizationId: params.organizationId,
      apartmentId: apartment.id,
      listingType: "condo",
      occupancyStatus: "vacant",
      listingStatus: "listed",
      currency: "MYR",
      rentalRate: params.expectedRental ?? null,
      readyNow: true,
      inChargePartyId: params.inChargePartyId,
      sourcingAgentId: params.sourcingAgentId,
      salesUnitOriginId: params.salesUnitId,
      visibilityMode: "PUBLIC",
    },
    select: { id: true },
  });
  return created;
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
