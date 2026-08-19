import { getDb, Prisma } from "@kason/db";
import { canSeeCommission, type AdminRole } from "../../lib/rbac";

// ── Tier Mappings ───────────────────────────────────────────────────────────

export async function listTierMappings(
  orgId: string,
  filters: {
    claimType?: string;
    search?: string;
    sort?: "default" | "created" | "updated";
    order?: "asc" | "desc";
    from?: string;
    to?: string;
  } = {},
) {
  const db = getDb();
  const where: Prisma.AgentTierMappingWhereInput = { organizationId: orgId };
  if (filters.claimType) where.claimType = filters.claimType;
  if (filters.search) {
    const s = filters.search;
    where.OR = [
      { claimType:  { contains: s, mode: "insensitive" } },
      { agentLevel: { contains: s, mode: "insensitive" } },
    ];
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  const orderBy: Prisma.AgentTierMappingOrderByWithRelationInput | Prisma.AgentTierMappingOrderByWithRelationInput[] = (() => {
    const dir = filters.order ?? "asc";
    switch (filters.sort) {
      case "created":  return { createdAt: dir };
      case "updated":  return { updatedAt: dir };
      case "default":
      default:         return [{ claimType: "asc" }, { agentLevel: "asc" }];
    }
  })();

  return db.agentTierMapping.findMany({ where, orderBy });
}

export async function createTierMapping(
  orgId: string,
  data: { claimType: string; agentLevel: string; percentage: number },
) {
  const db = getDb();
  return db.agentTierMapping.create({
    data: { organizationId: orgId, ...data },
  });
}

export async function findTierMapping(orgId: string, id: string) {
  const db = getDb();
  return db.agentTierMapping.findFirst({
    where: { id, organizationId: orgId },
  });
}

export async function updateTierMapping(
  id: string,
  expectedUpdatedAt: Date | string,
  data: Record<string, unknown>,
): Promise<{ updatedAt: Date } | null> {
  const db = getDb();
  try {
    const updated = await db.agentTierMapping.update({
      where: { id, updatedAt: new Date(expectedUpdatedAt) },
      data,
      select: { updatedAt: true },
    });
    return { updatedAt: updated.updatedAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return null;
    }
    throw err;
  }
}

export async function deleteTierMapping(id: string) {
  const db = getDb();
  return db.agentTierMapping.delete({ where: { id } });
}

// ── Room Types ─────────────────────────────────────────────────────────────

export async function listRoomTypes(
  orgId: string,
  filters: {
    search?: string;
    activeOnly?: boolean;
    sort?: "sortOrder" | "name" | "created" | "updated";
    order?: "asc" | "desc";
    from?: Date;
    to?: Date;
  } = {},
) {
  const db = getDb();
  const where: Prisma.RoomTypeWhereInput = { organizationId: orgId };
  if (filters.search) where.name = { contains: filters.search, mode: "insensitive" };
  if (filters.activeOnly) where.isActive = true;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to)   where.createdAt.lte = filters.to;
  }

  const orderBy: Prisma.RoomTypeOrderByWithRelationInput = (() => {
    const dir = filters.order ?? "asc";
    switch (filters.sort) {
      case "name":      return { name: dir };
      case "created":   return { createdAt: dir };
      case "updated":   return { updatedAt: dir };
      case "sortOrder":
      default:          return { sortOrder: dir };
    }
  })();

  return db.roomType.findMany({ where, orderBy });
}

export async function createRoomType(
  orgId: string,
  input: { name: string; kind?: string; sortOrder?: number; isActive?: boolean },
) {
  const db = getDb();
  return db.roomType.create({
    data: {
      organizationId: orgId,
      name: input.name,
      kind: input.kind ?? "PARTITION",
      sortOrder: input.sortOrder ?? 0,
      isActive: input.isActive ?? true,
    },
  });
}

export async function findRoomType(orgId: string, id: string) {
  const db = getDb();
  return db.roomType.findFirst({ where: { id, organizationId: orgId } });
}

export async function updateRoomType(
  id: string,
  data: { name?: string; kind?: string; sortOrder?: number; isActive?: boolean },
) {
  const db = getDb();
  return db.roomType.update({ where: { id }, data });
}

export async function deleteRoomType(id: string) {
  const db = getDb();
  return db.roomType.delete({ where: { id } });
}

// ── Claims ──────────────────────────────────────────────────────────────────

export async function listClaims(
  orgId: string,
  filters: {
    agentPartyId?: string;
    status?: string;
    claimType?: string;
    dateField?: "createdAt" | "salesDate" | "moveInDate";
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sort?: "newest" | "oldest" | "updated" | "status" | "claimType";
    page?: number;
    limit?: number;
  } = {},
  role: AdminRole = "admin",
) {
  const db = getDb();
  const where: Prisma.CommissionClaimWhereInput = { organizationId: orgId };
  if (filters.agentPartyId) where.agentPartyId = filters.agentPartyId;
  if (filters.status)       where.status = filters.status;
  if (filters.claimType)    where.claimType = filters.claimType;

  const dateField = filters.dateField ?? "createdAt";
  if (filters.dateFrom || filters.dateTo) {
    if (dateField === "createdAt") {
      where.createdAt = {};
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo)   where.createdAt.lte = new Date(filters.dateTo);
    } else {
      where.items = {
        some: {
          [dateField]: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo   ? { lte: new Date(filters.dateTo) } : {}),
          },
        },
      };
    }
  }

  if (filters.search) {
    const s = filters.search;
    where.OR = [
      { claimNumber: { contains: s, mode: "insensitive" } },
      { agent: { displayName: { contains: s, mode: "insensitive" } } },
      { items: { some: { unitCode:   { contains: s, mode: "insensitive" } } } },
      { items: { some: { tenantName: { contains: s, mode: "insensitive" } } } },
      { items: { some: { condoName:  { contains: s, mode: "insensitive" } } } },
    ];
  }

  const orderBy: Prisma.CommissionClaimOrderByWithRelationInput = (() => {
    switch (filters.sort) {
      case "oldest":    return { createdAt: "asc" };
      case "updated":   return { updatedAt: "desc" };
      case "status":    return { status: "asc" };
      case "claimType": return { claimType: "asc" };
      case "newest":
      default:          return { createdAt: "desc" };
    }
  })();

  const page  = filters.page  ?? 1;
  const limit = Math.min(filters.limit ?? 50, 200);

  // Role-aware select: editor never receives `totalNettPayout`.
  // List-shape extras (currency, claimType, updatedAt, agent relation)
  // are included regardless of tier so the list UI has labels and filters.
  const listSelect = {
    id: true,
    claimNumber: true,
    status: true,
    claimType: true,
    currency: true,
    submittedAt: true,
    createdAt: true,
    updatedAt: true,
    agentPartyId: true,
    agent: { select: { id: true, displayName: true } },
    ...(canSeeCommission(role) ? { totalNettPayout: true } : {}),
  } satisfies Prisma.CommissionClaimSelect;

  const [data, total] = await Promise.all([
    db.commissionClaim.findMany({
      where, orderBy,
      skip: (page - 1) * limit,
      take: limit,
      select: listSelect,
    }),
    db.commissionClaim.count({ where }),
  ]);

  return { data, page, limit, total };
}

export async function findClaim(
  orgId: string,
  claimId: string,
  role: AdminRole = "admin",
) {
  const db = getDb();
  const canSee = canSeeCommission(role);
  // Role-aware select: editor does NOT receive `totalNettPayout`, `items`,
  // `billId`, `cashMovementId`, or bank-account-number fields.
  // Internal workflows (approve/reject/pay/undo) always pass role="admin"
  // or at least "manager" so they still see everything they need.
  const select = {
    id: true,
    organizationId: true,
    claimNumber: true,
    status: true,
    currency: true,
    claimType: true,
    submittedAt: true,
    approvedAt: true,
    paidAt: true,
    agentPartyId: true,
    agent: {
      select: {
        id: true,
        displayName: true,
        primaryEmail: true,
        primaryPhone: true,
        ...(canSee
          ? {
              bankName: true,
              bankAccountHolder: true,
              bankAccountNumber: true,
            }
          : {}),
      },
    },
    ...(canSee
      ? {
          totalNettPayout: true,
          billId: true,
          cashMovementId: true,
          approvedBy: true,
          items: {
            include: {
              property: { select: { name: true } },
            },
            orderBy: { createdAt: "asc" as const },
          },
        }
      : {}),
  } satisfies Prisma.CommissionClaimSelect;

  return db.commissionClaim.findFirst({
    where: { id: claimId, organizationId: orgId },
    select,
  });
}

export async function generateBillNumber(orgId: string): Promise<string> {
  const db = getDb();
  const year = new Date().getFullYear();
  const prefix = `BILL-${year}-`;
  const latest = await db.commissionBill.findFirst({
    where: { organizationId: orgId, billNumber: { startsWith: prefix } },
    orderBy: { billNumber: "desc" },
    select: { billNumber: true },
  });
  const lastSeq = latest ? (parseInt(latest.billNumber.slice(prefix.length), 10) || 0) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
}

export type ClaimSummary = {
  id: string;
  claimNumber: string;
  status: string;
  totalNettPayout: number | { toString(): string };
  currency: string;
  agentPartyId: string;
};

export async function findClaimsByIds(orgId: string, claimIds: string[]): Promise<ClaimSummary[]> {
  const db = getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db as any).commissionClaim.findMany({
    where: { organizationId: orgId, id: { in: claimIds } },
    select: {
      id: true,
      claimNumber: true,
      status: true,
      totalNettPayout: true,
      currency: true,
      agentPartyId: true,
    },
  });
}

export type BulkApproveRow = {
  claimId: string;
  claimNumber: string;
  agentPartyId: string;
  totalNettPayout: number;
  currency: string;
  billNumber: string;
};

export async function undoApproveTx(
  orgId: string,
  userId: string,
  claimId: string,
  billId: string,
  claimNumber: string,
) {
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.commissionBill.delete({ where: { id: billId } });
    await tx.commissionClaim.update({
      where: { id: claimId },
      data: { status: "submitted", billId: null, approvedAt: null, approvedBy: null },
    });
    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "commission_claim",
        entityId: claimId,
        action: "approve_undone",
        description: `Approve undone for claim ${claimNumber}`,
        performedBy: userId,
        metadata: { claimNumber, undone: true },
      },
    });
  });
}

export async function bulkApproveTx(
  orgId: string,
  userId: string,
  rows: BulkApproveRow[],
) {
  const db = getDb();
  await db.$transaction(async (tx) => {
    for (const row of rows) {
      const bill = await tx.commissionBill.create({
        data: {
          organizationId: orgId,
          billNumber: row.billNumber,
          partyId: row.agentPartyId,
          propertyId: null,
          category: "commission",
          description: `Commission claim ${row.claimNumber}`,
          amount: row.totalNettPayout,
          currency: row.currency,
          status: "pending",
        },
      });
      await tx.commissionClaim.update({
        where: { id: row.claimId },
        data: {
          status: "approved",
          billId: bill.id,
          approvedAt: new Date(),
          approvedBy: userId,
        },
      });
      await tx.activityLog.create({
        data: {
          organizationId: orgId,
          entityType: "commission_claim",
          entityId: row.claimId,
          action: "approved",
          description: `Claim ${row.claimNumber} approved (bulk)`,
          performedBy: userId,
          metadata: { billNumber: row.billNumber, claimNumber: row.claimNumber, bulk: true },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        entityType: "commission_claim",
        entityId: "bulk",
        action: "bulk_approved",
        description: `Bulk-approved ${rows.length} claim(s)`,
        performedBy: userId,
        metadata: { claimIds: rows.map((r) => r.claimId) },
      },
    });
  });
}
