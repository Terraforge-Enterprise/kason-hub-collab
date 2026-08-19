import { getDb, Prisma } from "@kason/db";
import type { AdminRole } from "../../lib/rbac";
import { renovationClaimSelectFor } from "../../lib/rbac";
import type {
  ListClaimsQuery,
  ListPackagesQuery,
  PackageSplitInput,
  RenovationClaimDocumentRow,
  RenovationClaimRow,
  RenovationClaimSplitRow,
  RenovationClaimStatus,
  RenovationPackageRow,
  RenovationPackageSplitRow,
} from "./renovation-claims.types";

const PACKAGE_SELECT = {
  id: true,
  organizationId: true,
  key: true,
  label: true,
  description: true,
  defaultPrice: true,
  archived: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  defaultSplits: {
    select: {
      id: true,
      organizationId: true,
      packageId: true,
      roleLabel: true,
      splitType: true,
      splitValue: true,
      isHouseKeep: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

type RawPackageSplit = {
  id: string;
  organizationId: string;
  packageId: string;
  roleLabel: string;
  splitType: string;
  splitValue: Prisma.Decimal;
  isHouseKeep: boolean;
  sortOrder: number;
};

type RawPackage = {
  id: string;
  organizationId: string;
  key: string;
  label: string;
  description: string | null;
  defaultPrice: Prisma.Decimal;
  archived: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  defaultSplits: RawPackageSplit[];
};

function mapPackageSplit(row: RawPackageSplit): RenovationPackageSplitRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    packageId: row.packageId,
    roleLabel: row.roleLabel,
    splitType: row.splitType as "percent" | "fixed",
    splitValue: decToNumber(row.splitValue) ?? 0,
    isHouseKeep: row.isHouseKeep,
    sortOrder: row.sortOrder,
  };
}

function mapPackage(row: RawPackage): RenovationPackageRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    label: row.label,
    description: row.description,
    defaultPrice: decToNumber(row.defaultPrice) ?? 0,
    archived: row.archived,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    defaultSplits: row.defaultSplits.map(mapPackageSplit),
  };
}

// ─── Packages ────────────────────────────────────────────────────────────────

export async function listPackages(
  organizationId: string,
  filters?: ListPackagesQuery,
): Promise<RenovationPackageRow[]> {
  const db = getDb();
  const where: Prisma.RenovationPackageWhereInput = {
    organizationId,
    ...(filters?.archived !== undefined ? { archived: filters.archived } : {}),
  };
  const rows = await db.renovationPackage.findMany({
    where,
    select: PACKAGE_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
  return (rows as unknown as RawPackage[]).map(mapPackage);
}

export async function findPackageById(
  organizationId: string,
  id: string,
): Promise<RenovationPackageRow | null> {
  const db = getDb();
  const row = await db.renovationPackage.findFirst({
    where: { id, organizationId },
    select: PACKAGE_SELECT,
  });
  if (!row) return null;
  return mapPackage(row as unknown as RawPackage);
}

export async function findPackageByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<RenovationPackageRow | null> {
  const row = await tx.renovationPackage.findFirst({
    where: { id, organizationId },
    select: PACKAGE_SELECT,
  });
  if (!row) return null;
  return mapPackage(row as unknown as RawPackage);
}

export async function findPackageByKeyConflict(params: {
  organizationId: string;
  key: string;
  excludeId?: string;
}): Promise<{ id: string } | null> {
  const db = getDb();
  return db.renovationPackage.findFirst({
    where: {
      organizationId: params.organizationId,
      key: params.key,
      ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
    },
    select: { id: true },
  });
}

export async function createPackageRow(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    key: string;
    label: string;
    description: string | null;
    defaultPrice: number;
    archived: boolean;
    sortOrder: number;
    defaultSplits: PackageSplitInput[];
  },
): Promise<RenovationPackageRow> {
  const row = await tx.renovationPackage.create({
    data: {
      organizationId: input.organizationId,
      key: input.key,
      label: input.label,
      description: input.description,
      defaultPrice: input.defaultPrice,
      archived: input.archived,
      sortOrder: input.sortOrder,
      defaultSplits: {
        create: input.defaultSplits.map((s) => ({
          organizationId: input.organizationId,
          roleLabel: s.roleLabel,
          splitType: s.splitType,
          splitValue: s.splitValue,
          isHouseKeep: s.isHouseKeep,
          sortOrder: s.sortOrder,
        })),
      },
    },
    select: PACKAGE_SELECT,
  });
  return mapPackage(row as unknown as RawPackage);
}

export async function updatePackageRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: {
    label?: string;
    description?: string | null;
    defaultPrice?: number;
    archived?: boolean;
    sortOrder?: number;
    // Pass `undefined` to keep existing splits; pass an array to replace them.
    defaultSplits?: PackageSplitInput[];
  },
): Promise<RenovationPackageRow> {
  const data: Prisma.RenovationPackageUpdateInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.description !== undefined) data.description = input.description;
  if (input.defaultPrice !== undefined) data.defaultPrice = input.defaultPrice;
  if (input.archived !== undefined) data.archived = input.archived;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  if (input.defaultSplits !== undefined) {
    // Replace strategy: delete all existing splits, recreate from the input
    // array. Caller has already validated the 100% rule.
    // Scope by organizationId as defence-in-depth — the service pre-checks
    // ownership today, but a future refactor that bypasses it must NOT
    // silently delete cross-org rows.
    await tx.renovationPackageSplit.deleteMany({
      where: { packageId: id, organizationId },
    });
    data.defaultSplits = {
      create: input.defaultSplits.map((s) => ({
        organizationId,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        isHouseKeep: s.isHouseKeep,
        sortOrder: s.sortOrder,
      })),
    };
  }

  const row = await tx.renovationPackage.update({
    where: { id, organizationId },
    data,
    select: PACKAGE_SELECT,
  });
  return mapPackage(row as unknown as RawPackage);
}

// ─── Claims ──────────────────────────────────────────────────────────────────

type RawClaimSplit = {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: string;
  splitValue: Prisma.Decimal;
  isHouseKeep: boolean;
  sortOrder: number;
};

type RawClaimDoc = {
  id: string;
  organizationId: string;
  claimId: string;
  kind: string;
  fileKey: string;
  filename: string;
  uploadedAt: Date;
  uploadedById: string;
};

type RawClaim = {
  id: string;
  organizationId: string;
  salesUnitId: string;
  packageId: string;
  packagePrice?: Prisma.Decimal;
  paymentType: string;
  monthlyOffsetAmount?: Prisma.Decimal | null;
  status: string;
  notes: string | null;
  submittedAt: Date;
  submittedById: string;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits?: RawClaimSplit[];
  documents?: RawClaimDoc[];
};

function mapClaimSplit(row: RawClaimSplit): RenovationClaimSplitRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    claimId: row.claimId,
    partyPartyId: row.partyPartyId,
    partyDisplayName: row.partyDisplayName,
    roleLabel: row.roleLabel,
    splitType: row.splitType as "percent" | "fixed",
    splitValue: decToNumber(row.splitValue) ?? 0,
    isHouseKeep: row.isHouseKeep,
    sortOrder: row.sortOrder,
  };
}

function mapClaimDoc(row: RawClaimDoc): RenovationClaimDocumentRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    claimId: row.claimId,
    kind: row.kind as "quotation" | "invoice" | "agreement",
    fileKey: row.fileKey,
    filename: row.filename,
    uploadedAt: row.uploadedAt,
    uploadedById: row.uploadedById,
  };
}

function mapClaim(row: RawClaim): RenovationClaimRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    salesUnitId: row.salesUnitId,
    packageId: row.packageId,
    packagePrice: decToNumber(row.packagePrice ?? null),
    paymentType: row.paymentType as RenovationClaimRow["paymentType"],
    monthlyOffsetAmount: decToNumber(row.monthlyOffsetAmount ?? null),
    status: row.status as RenovationClaimStatus,
    notes: row.notes,
    submittedAt: row.submittedAt,
    submittedById: row.submittedById,
    reviewedAt: row.reviewedAt,
    reviewedById: row.reviewedById,
    reviewerNote: row.reviewerNote,
    splits: row.splits ? row.splits.map(mapClaimSplit) : null,
    documents: row.documents ? row.documents.map(mapClaimDoc) : null,
  };
}

/**
 * Resolve the effective select-shape role. When `forceFullSelect` is true
 * (the portal own-only path), upgrade to "manager" so the caller sees their
 * own splits/documents/packagePrice. Caller is responsible for ownership
 * gating BEFORE setting this flag.
 */
function effectiveRole(role: AdminRole, forceFullSelect?: boolean): AdminRole {
  return forceFullSelect ? "manager" : role;
}

export async function listClaims(
  organizationId: string,
  role: AdminRole,
  filters: ListClaimsQuery & { submittedByEq?: string },
  options?: { forceFullSelect?: boolean },
): Promise<RenovationClaimRow[]> {
  const db = getDb();
  const where: Prisma.RenovationClaimWhereInput = {
    organizationId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.salesUnitId ? { salesUnitId: filters.salesUnitId } : {}),
    ...(filters.submittedById ? { submittedById: filters.submittedById } : {}),
    ...(filters.submittedByEq ? { submittedById: filters.submittedByEq } : {}),
    ...(filters.submittedFrom || filters.submittedTo
      ? {
          submittedAt: {
            ...(filters.submittedFrom ? { gte: new Date(filters.submittedFrom) } : {}),
            ...(filters.submittedTo ? { lte: new Date(filters.submittedTo) } : {}),
          },
        }
      : {}),
  };
  const select = renovationClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const rows = await db.renovationClaim.findMany({
    where,
    select,
    orderBy: [{ submittedAt: "desc" }],
    take: 200,
  });
  return (rows as unknown as RawClaim[]).map(mapClaim);
}

export async function findClaimById(
  organizationId: string,
  role: AdminRole,
  id: string,
  options?: { forceFullSelect?: boolean },
): Promise<RenovationClaimRow | null> {
  const db = getDb();
  const select = renovationClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const row = await db.renovationClaim.findFirst({
    where: { id, organizationId },
    select,
  });
  if (!row) return null;
  return mapClaim(row as unknown as RawClaim);
}

export async function findClaimByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  role: AdminRole,
  id: string,
  options?: { forceFullSelect?: boolean },
): Promise<RenovationClaimRow | null> {
  const select = renovationClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const row = await tx.renovationClaim.findFirst({
    where: { id, organizationId },
    select,
  });
  if (!row) return null;
  return mapClaim(row as unknown as RawClaim);
}

/**
 * Find a claim with the FULL manager+ shape regardless of caller role.
 * Service-side mutations (approve, edit-rebound, validation) need the
 * complete row to re-run business rules.
 */
export async function findFullClaimByIdTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  id: string,
): Promise<RenovationClaimRow | null> {
  return findClaimByIdTx(tx, organizationId, "manager", id);
}

export async function createClaimRow(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    salesUnitId: string;
    packageId: string;
    packagePrice: number;
    paymentType: string;
    monthlyOffsetAmount: number | null;
    notes: string | null;
    submittedById: string;
    splits: Array<{
      partyPartyId: string | null;
      partyDisplayName: string;
      roleLabel: string;
      splitType: string;
      splitValue: number;
      isHouseKeep: boolean;
      sortOrder: number;
    }>;
  },
): Promise<RenovationClaimRow> {
  const row = await tx.renovationClaim.create({
    data: {
      organizationId: input.organizationId,
      salesUnitId: input.salesUnitId,
      packageId: input.packageId,
      packagePrice: input.packagePrice,
      paymentType: input.paymentType,
      monthlyOffsetAmount: input.monthlyOffsetAmount,
      notes: input.notes,
      submittedById: input.submittedById,
      status: "submitted",
      splits: {
        create: input.splits.map((s) => ({
          organizationId: input.organizationId,
          partyPartyId: s.partyPartyId,
          partyDisplayName: s.partyDisplayName,
          roleLabel: s.roleLabel,
          splitType: s.splitType,
          splitValue: s.splitValue,
          isHouseKeep: s.isHouseKeep,
          sortOrder: s.sortOrder,
        })),
      },
    },
    select: renovationClaimSelectFor("manager"),
  });
  return mapClaim(row as unknown as RawClaim);
}

export async function updateClaimRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: {
    packageId?: string;
    packagePrice?: number;
    paymentType?: string;
    monthlyOffsetAmount?: number | null;
    notes?: string | null;
    status?: RenovationClaimStatus;
    reviewerNote?: string | null;
    reviewedAt?: Date | null;
    reviewedById?: string | null;
    splits?: Array<{
      partyPartyId: string | null;
      partyDisplayName: string;
      roleLabel: string;
      splitType: string;
      splitValue: number;
      isHouseKeep: boolean;
      sortOrder: number;
    }>;
  },
): Promise<RenovationClaimRow> {
  const data: Prisma.RenovationClaimUpdateInput = {};
  if (input.packageId !== undefined) {
    data.package = { connect: { id: input.packageId } };
  }
  if (input.packagePrice !== undefined) data.packagePrice = input.packagePrice;
  if (input.paymentType !== undefined) data.paymentType = input.paymentType;
  if (input.monthlyOffsetAmount !== undefined) {
    data.monthlyOffsetAmount = input.monthlyOffsetAmount;
  }
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.status !== undefined) data.status = input.status;
  if (input.reviewerNote !== undefined) data.reviewerNote = input.reviewerNote;
  if (input.reviewedAt !== undefined) data.reviewedAt = input.reviewedAt;
  if (input.reviewedById !== undefined) data.reviewedById = input.reviewedById;

  if (input.splits !== undefined) {
    // Scope by organizationId as defence-in-depth (see updatePackageRow).
    await tx.renovationClaimSplit.deleteMany({
      where: { claimId: id, organizationId },
    });
    data.splits = {
      create: input.splits.map((s) => ({
        organizationId,
        partyPartyId: s.partyPartyId,
        partyDisplayName: s.partyDisplayName,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        isHouseKeep: s.isHouseKeep,
        sortOrder: s.sortOrder,
      })),
    };
  }

  const row = await tx.renovationClaim.update({
    where: { id, organizationId },
    data,
    select: renovationClaimSelectFor("manager"),
  });
  return mapClaim(row as unknown as RawClaim);
}

export type ClaimTransitionRow = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
};

/**
 * Audit timeline for a single RenovationClaim, oldest-first. Mirrors
 * sales-claims.repository.listSalesClaimTransitions — same shape on the
 * wire so the FE can render both with one component.
 *
 * Org isolation: caller must verify the claim belongs to `organizationId`
 * (admin via requireRole + claim-fetch ownership; portal via
 * `requireSubmittedById`). The org filter is repeated here as
 * defence-in-depth.
 */
export async function listRenovationClaimTransitions(
  organizationId: string,
  claimId: string,
): Promise<ClaimTransitionRow[]> {
  const db = getDb();
  const rows = await db.renovationClaimTransition.findMany({
    where: { organizationId, claimId },
    orderBy: { changedAt: "asc" },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      changedById: true,
      changedAt: true,
      note: true,
    },
  });
  if (rows.length === 0) return [];
  const userIds = Array.from(new Set(rows.map((r) => r.changedById)));
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.fullName]));
  return rows.map((r) => ({
    id: r.id,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    changedById: r.changedById,
    changedByName: nameById.get(r.changedById) ?? null,
    changedAt: r.changedAt.toISOString(),
    note: r.note,
  }));
}

export async function appendClaimTransition(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    claimId: string;
    fromStatus: string | null;
    toStatus: string;
    changedById: string;
    note: string | null;
  },
): Promise<void> {
  await tx.renovationClaimTransition.create({
    data: {
      organizationId: params.organizationId,
      claimId: params.claimId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      changedById: params.changedById,
      note: params.note,
    },
  });
}

// ─── Documents ──────────────────────────────────────────────────────────────

export async function findClaimDocumentById(
  organizationId: string,
  claimId: string,
  docId: string,
): Promise<RenovationClaimDocumentRow | null> {
  const db = getDb();
  const row = await db.renovationClaimDocument.findFirst({
    where: { id: docId, claimId, organizationId },
    select: {
      id: true,
      organizationId: true,
      claimId: true,
      kind: true,
      fileKey: true,
      filename: true,
      uploadedAt: true,
      uploadedById: true,
    },
  });
  if (!row) return null;
  return mapClaimDoc(row as unknown as RawClaimDoc);
}

export async function listClaimDocuments(
  organizationId: string,
  claimId: string,
): Promise<RenovationClaimDocumentRow[]> {
  const db = getDb();
  const rows = await db.renovationClaimDocument.findMany({
    where: { claimId, organizationId },
    select: {
      id: true,
      organizationId: true,
      claimId: true,
      kind: true,
      fileKey: true,
      filename: true,
      uploadedAt: true,
      uploadedById: true,
    },
    orderBy: { uploadedAt: "asc" },
  });
  return rows.map((r) => mapClaimDoc(r as unknown as RawClaimDoc));
}

export async function listClaimDocumentsTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  claimId: string,
): Promise<RenovationClaimDocumentRow[]> {
  const rows = await tx.renovationClaimDocument.findMany({
    where: { claimId, organizationId },
    select: {
      id: true,
      organizationId: true,
      claimId: true,
      kind: true,
      fileKey: true,
      filename: true,
      uploadedAt: true,
      uploadedById: true,
    },
    orderBy: { uploadedAt: "asc" },
  });
  return rows.map((r) => mapClaimDoc(r as unknown as RawClaimDoc));
}

export async function createClaimDocumentRow(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    claimId: string;
    kind: string;
    fileKey: string;
    filename: string;
    uploadedById: string;
  },
): Promise<RenovationClaimDocumentRow> {
  const row = await tx.renovationClaimDocument.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.claimId,
      kind: input.kind,
      fileKey: input.fileKey,
      filename: input.filename,
      uploadedById: input.uploadedById,
    },
    select: {
      id: true,
      organizationId: true,
      claimId: true,
      kind: true,
      fileKey: true,
      filename: true,
      uploadedAt: true,
      uploadedById: true,
    },
  });
  return mapClaimDoc(row as unknown as RawClaimDoc);
}

export async function deleteClaimDocumentRow(
  tx: Prisma.TransactionClient,
  organizationId: string,
  claimId: string,
  docId: string,
): Promise<void> {
  await tx.renovationClaimDocument.deleteMany({
    where: { id: docId, claimId, organizationId },
  });
}

// ─── SalesUnit lookup (for ownership / org check) ────────────────────────────

export async function findSalesUnitForClaim(
  organizationId: string,
  salesUnitId: string,
): Promise<{ id: string; agentPartyId: string } | null> {
  const db = getDb();
  return db.salesUnit.findFirst({
    where: { id: salesUnitId, organizationId },
    select: { id: true, agentPartyId: true },
  });
}

export async function findSalesUnitForClaimTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  salesUnitId: string,
): Promise<{ id: string; agentPartyId: string } | null> {
  return tx.salesUnit.findFirst({
    where: { id: salesUnitId, organizationId },
    select: { id: true, agentPartyId: true },
  });
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
