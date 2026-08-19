import { getDb, Prisma } from "@kason/db";
import type { AdminRole } from "../../lib/rbac";
import { salesClaimSelectFor } from "../../lib/rbac";
import type {
  CommissionType,
  ListClaimsQuery,
  SalesClaimRow,
  SalesClaimSplitRow,
  SalesClaimStatus,
  SalesPaymentType,
} from "./sales-claims.types";

function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

type RawClaimSplit = {
  id: string;
  organizationId: string;
  claimId: string;
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: string;
  splitValue: Prisma.Decimal;
  sortOrder: number;
};

type RawClaim = {
  id: string;
  organizationId: string;
  salesUnitId: string;
  commissionType: string;
  commissionValue?: Prisma.Decimal;
  computedAmount?: Prisma.Decimal;
  paymentType: string;
  status: string;
  notes: string | null;
  submittedAt: Date;
  submittedById: string;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewerNote: string | null;
  splits?: RawClaimSplit[];
};

function mapClaimSplit(row: RawClaimSplit): SalesClaimSplitRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    claimId: row.claimId,
    partyPartyId: row.partyPartyId,
    partyDisplayName: row.partyDisplayName,
    roleLabel: row.roleLabel,
    splitType: row.splitType as "percent" | "fixed",
    splitValue: decToNumber(row.splitValue) ?? 0,
    sortOrder: row.sortOrder,
  };
}

function mapClaim(row: RawClaim): SalesClaimRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    salesUnitId: row.salesUnitId,
    commissionType: row.commissionType as CommissionType,
    commissionValue: decToNumber(row.commissionValue ?? null),
    computedAmount: decToNumber(row.computedAmount ?? null),
    paymentType: row.paymentType as SalesPaymentType,
    status: row.status as SalesClaimStatus,
    notes: row.notes,
    submittedAt: row.submittedAt,
    submittedById: row.submittedById,
    reviewedAt: row.reviewedAt,
    reviewedById: row.reviewedById,
    reviewerNote: row.reviewerNote,
    splits: row.splits ? row.splits.map(mapClaimSplit) : null,
  };
}

/**
 * Resolve the effective select-shape role. When `forceFullSelect` is true
 * (the portal own-only path), upgrade to "manager" so the caller sees their
 * own splits / commissionValue / computedAmount. Caller is responsible for
 * ownership gating BEFORE setting this flag.
 */
function effectiveRole(role: AdminRole, forceFullSelect?: boolean): AdminRole {
  return forceFullSelect ? "manager" : role;
}

export async function listClaims(
  organizationId: string,
  role: AdminRole,
  filters: ListClaimsQuery & { submittedByEq?: string },
  options?: { forceFullSelect?: boolean },
): Promise<SalesClaimRow[]> {
  const db = getDb();
  const where: Prisma.SalesClaimWhereInput = {
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
  const select = salesClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const rows = await db.salesClaim.findMany({
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
): Promise<SalesClaimRow | null> {
  const db = getDb();
  const select = salesClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const row = await db.salesClaim.findFirst({
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
): Promise<SalesClaimRow | null> {
  const select = salesClaimSelectFor(effectiveRole(role, options?.forceFullSelect));
  const row = await tx.salesClaim.findFirst({
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
): Promise<SalesClaimRow | null> {
  return findClaimByIdTx(tx, organizationId, "manager", id);
}

export async function createClaimRow(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    salesUnitId: string;
    commissionType: CommissionType;
    commissionValue: number;
    computedAmount: number;
    paymentType: SalesPaymentType;
    notes: string | null;
    submittedById: string;
    splits: Array<{
      partyPartyId: string | null;
      partyDisplayName: string;
      roleLabel: string;
      splitType: string;
      splitValue: number;
      sortOrder: number;
    }>;
  },
): Promise<SalesClaimRow> {
  const row = await tx.salesClaim.create({
    data: {
      organizationId: input.organizationId,
      salesUnitId: input.salesUnitId,
      commissionType: input.commissionType,
      commissionValue: input.commissionValue,
      computedAmount: input.computedAmount,
      paymentType: input.paymentType,
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
          sortOrder: s.sortOrder,
        })),
      },
    },
    select: salesClaimSelectFor("manager"),
  });
  return mapClaim(row as unknown as RawClaim);
}

export async function updateClaimRow(
  tx: Prisma.TransactionClient,
  id: string,
  organizationId: string,
  input: {
    commissionType?: CommissionType;
    commissionValue?: number;
    computedAmount?: number;
    paymentType?: SalesPaymentType;
    notes?: string | null;
    status?: SalesClaimStatus;
    reviewerNote?: string | null;
    reviewedAt?: Date | null;
    reviewedById?: string | null;
    splits?: Array<{
      partyPartyId: string | null;
      partyDisplayName: string;
      roleLabel: string;
      splitType: string;
      splitValue: number;
      sortOrder: number;
    }>;
  },
): Promise<SalesClaimRow> {
  const data: Prisma.SalesClaimUpdateInput = {};
  if (input.commissionType !== undefined) data.commissionType = input.commissionType;
  if (input.commissionValue !== undefined) data.commissionValue = input.commissionValue;
  if (input.computedAmount !== undefined) data.computedAmount = input.computedAmount;
  if (input.paymentType !== undefined) data.paymentType = input.paymentType;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.status !== undefined) data.status = input.status;
  if (input.reviewerNote !== undefined) data.reviewerNote = input.reviewerNote;
  if (input.reviewedAt !== undefined) data.reviewedAt = input.reviewedAt;
  if (input.reviewedById !== undefined) data.reviewedById = input.reviewedById;

  if (input.splits !== undefined) {
    // Replace strategy: delete all existing splits, recreate from input.
    // Caller has already validated the 100% rule.
    // Scope by organizationId as defence-in-depth (per W2b lesson).
    await tx.salesClaimSplit.deleteMany({
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
        sortOrder: s.sortOrder,
      })),
    };
  }

  const row = await tx.salesClaim.update({
    where: { id, organizationId },
    data,
    select: salesClaimSelectFor("manager"),
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
 * List the transition history for a single SalesClaim, oldest-first.
 *
 * Org isolation: caller is responsible for verifying the claim belongs to
 * `organizationId` (admin routes do this via the requireRole middleware +
 * the existing `findFullClaimById` ownership check; portal routes via
 * `requireSubmittedById`). This function repeats the org filter as a
 * defence-in-depth measure so a leaked claim id can't be used to cross orgs.
 */
export async function listSalesClaimTransitions(
  organizationId: string,
  claimId: string,
): Promise<ClaimTransitionRow[]> {
  const db = getDb();
  const rows = await db.salesClaimTransition.findMany({
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
  // Resolve changedById -> fullName in one round-trip. The transition
  // schema doesn't carry a Prisma relation to User (deliberate, to keep
  // the audit row lean), so we look up names separately. Same pattern as
  // findUnitDetail's hiddenFromAgentNames resolution.
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
  await tx.salesClaimTransition.create({
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

// ─── SalesUnit lookup (for ownership / org check / purchasePrice) ────────────

export async function findSalesUnitForClaim(
  organizationId: string,
  salesUnitId: string,
): Promise<{ id: string; agentPartyId: string; purchasePrice: number } | null> {
  const db = getDb();
  const row = await db.salesUnit.findFirst({
    where: { id: salesUnitId, organizationId },
    select: { id: true, agentPartyId: true, purchasePrice: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    agentPartyId: row.agentPartyId,
    purchasePrice: decToNumber(row.purchasePrice) ?? 0,
  };
}

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}
