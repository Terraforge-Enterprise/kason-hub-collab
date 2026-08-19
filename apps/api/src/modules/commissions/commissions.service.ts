import { getDb, Prisma } from "@kason/db";
import { formatMyPhoneDisplay, readPhoneAnyFormat } from "@kason/shared";
import type { CommissionsSession } from "./commissions.types";
import { upgradeAgentLevelIfEligible } from "./agent-level-upgrade";
import { canSeeCommission, type AdminRole } from "../../lib/rbac";
import {
  listTierMappings,
  createTierMapping,
  findTierMapping,
  updateTierMapping,
  deleteTierMapping,
  listClaims,
  findClaim,
  listRoomTypes,
  createRoomType,
  findRoomType,
  updateRoomType,
  deleteRoomType,
  findClaimsByIds,
  bulkApproveTx,
  undoApproveTx,
  generateBillNumber,
} from "./commissions.repository";
import { assertTransition, type ClaimStatus } from "../portal/commissions/claim-state-machine";
import { isClaimError, claimErrorToHttpStatus } from "../portal/commissions/claim-errors";
import { recordAudit } from "../../lib/audit";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import { renderToHtml } from "../../lib/document-templates/render";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { buildCommissionClaimBodyHtml } from "./pdf-body";
import { getClaimService as getPortalClaimService } from "../portal/commissions/portal.commissions.service";

// ── Tier Mappings ───────────────────────────────────────────────────────────

export async function listTierMappingsService(
  session: CommissionsSession,
  filters: {
    claimType?: string;
    search?: string;
    sort?: "default" | "created" | "updated";
    order?: "asc" | "desc";
    from?: string;
    to?: string;
  } = {},
) {
  const mappings = await listTierMappings(session.orgId, filters);
  return {
    ok: true as const,
    status: 200,
    data: mappings.map((m) => ({ ...m, percentage: Number(m.percentage) })),
  };
}

export async function createTierMappingService(
  session: CommissionsSession,
  input: { claimType: string; agentLevel: string; percentage: string },
) {
  const db = getDb();
  let mapping;
  try {
    mapping = await createTierMapping(session.orgId, {
      claimType: input.claimType,
      agentLevel: input.agentLevel,
      percentage: Number(input.percentage),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false as const,
        status: 409,
        error: `A tier mapping for ${input.claimType} / ${input.agentLevel} already exists. Edit or reactivate the existing mapping instead.`,
      };
    }
    throw err;
  }

  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "agent_tier_mapping",
      entityId: mapping.id,
      action: "created",
      description: `Tier mapping created: ${input.claimType} / ${input.agentLevel} = ${input.percentage}%`,
      performedBy: session.userId,
      metadata: { claimType: input.claimType, agentLevel: input.agentLevel, percentage: input.percentage },
    },
  });

  return { ok: true as const, status: 201, data: { id: mapping.id } };
}

export async function updateTierMappingService(
  session: CommissionsSession,
  id: string,
  input: { updatedAt: string; percentage?: string; isActive?: boolean },
) {
  const existing = await findTierMapping(session.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: "Tier mapping not found" };

  const updateData: Record<string, unknown> = {};
  if (input.percentage !== undefined) updateData.percentage = Number(input.percentage);
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  const result = await updateTierMapping(id, input.updatedAt, updateData);
  if (!result) {
    const stillExists = await findTierMapping(session.orgId, id);
    if (!stillExists) return { ok: false as const, status: 404, error: "Tier mapping not found" };
    return { ok: false as const, status: 409, error: "Record changed — reloaded" };
  }

  const db = getDb();
  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "agent_tier_mapping",
      entityId: id,
      action: "updated",
      description: `Tier mapping updated: ${existing.claimType} / ${existing.agentLevel}`,
      performedBy: session.userId,
      metadata: { ...input, claimType: existing.claimType, agentLevel: existing.agentLevel },
    },
  });

  return { ok: true as const, status: 200, data: { id, updatedAt: result.updatedAt.toISOString() } };
}

export async function deleteTierMappingService(
  session: CommissionsSession,
  id: string,
) {
  const existing = await findTierMapping(session.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: "Tier mapping not found" };

  await deleteTierMapping(id);

  const db = getDb();
  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "agent_tier_mapping",
      entityId: id,
      action: "deleted",
      description: `Tier mapping deleted: ${existing.claimType} / ${existing.agentLevel} = ${Number(existing.percentage)}%`,
      performedBy: session.userId,
      metadata: { claimType: existing.claimType, agentLevel: existing.agentLevel, percentage: Number(existing.percentage) },
    },
  });

  return { ok: true as const, status: 200, data: { id } };
}

// ── Room Types ─────────────────────────────────────────────────────────────

export async function listRoomTypesService(
  session: CommissionsSession,
  filters: {
    search?: string;
    activeOnly?: boolean;
    sort?: "sortOrder" | "name" | "created" | "updated";
    order?: "asc" | "desc";
    from?: string;
    to?: string;
  } = {},
) {
  const roomTypes = await listRoomTypes(session.orgId, {
    search: filters.search,
    activeOnly: filters.activeOnly,
    sort: filters.sort,
    order: filters.order,
    from: filters.from ? new Date(filters.from) : undefined,
    to: filters.to ? new Date(filters.to) : undefined,
  });
  return { ok: true as const, status: 200, data: roomTypes };
}

export async function createRoomTypeService(
  session: CommissionsSession,
  input: { name: string; kind?: string; sortOrder?: number; isActive?: boolean },
) {
  let roomType;
  try {
    roomType = await createRoomType(session.orgId, input);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return {
        ok: false as const,
        status: 409,
        error: `A room type named "${input.name}" already exists (names are case-insensitive).`,
      };
    }
    // Also handle the case where test mocks reject with a plain Error with code "P2002".
    if ((err as { code?: string })?.code === "P2002") {
      return {
        ok: false as const,
        status: 409,
        error: `A room type named "${input.name}" already exists (names are case-insensitive).`,
      };
    }
    throw err;
  }

  const db = getDb();
  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "room_type",
      entityId: roomType.id,
      action: "created",
      description: `Room type created: ${input.name}`,
      performedBy: session.userId,
      metadata: { name: input.name, sortOrder: input.sortOrder, isActive: input.isActive },
    },
  });

  return { ok: true as const, status: 201, data: { id: roomType.id } };
}

export async function updateRoomTypeService(
  session: CommissionsSession,
  id: string,
  input: { name?: string; kind?: string; sortOrder?: number; isActive?: boolean },
) {
  const existing = await findRoomType(session.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: "Room type not found" };

  try {
    await updateRoomType(id, input);
  } catch (err) {
    const p2002 = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    const p2002Loose = (err as { code?: string })?.code === "P2002";
    if (p2002 || p2002Loose) {
      const conflictName = input.name ?? existing.name;
      return {
        ok: false as const,
        status: 409,
        error: `A room type named "${conflictName}" already exists.`,
      };
    }
    throw err;
  }

  const before = { name: existing.name, sortOrder: existing.sortOrder, isActive: existing.isActive };
  const after = { ...before, ...input };

  const db = getDb();
  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "room_type",
      entityId: id,
      action: "updated",
      description: `Room type updated: ${existing.name}`,
      performedBy: session.userId,
      metadata: { before, after },
    },
  });

  return { ok: true as const, status: 200, data: { id } };
}

export async function deleteRoomTypeService(
  session: CommissionsSession,
  id: string,
) {
  const existing = await findRoomType(session.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: "Room type not found" };

  const db = getDb();
  const activeUnitCount = await db.listing.count({
    where: {
      organizationId: session.orgId,
      listingType: existing.name,
      listingStatus: { not: "archived" },
    },
  });
  if (activeUnitCount > 0) {
    return {
      ok: false as const,
      status: 409 as const,
      error: {
        code: "ROOMTYPE_IN_USE" as const,
        activeUnitCount,
        suggestion: "Deactivate (set isActive=false) instead.",
      },
    };
  }

  await deleteRoomType(id);

  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "room_type",
      entityId: id,
      action: "deleted",
      description: `Room type deleted: ${existing.name}`,
      performedBy: session.userId,
      metadata: { name: existing.name, sortOrder: existing.sortOrder, isActive: existing.isActive },
    },
  });

  return { ok: true as const, status: 200, data: { id } };
}

export async function getRoomTypeUsageService(
  session: CommissionsSession,
  roomTypeId: string,
) {
  const db = getDb();
  const rt = await db.roomType.findFirst({
    where: { id: roomTypeId, organizationId: session.orgId },
    select: { name: true },
  });
  if (!rt) {
    return { ok: false as const, status: 404 as const, error: "Room type not found" };
  }
  const activeUnitCount = await db.listing.count({
    where: {
      organizationId: session.orgId,
      listingType: rt.name,
      listingStatus: { not: "archived" },
    },
  });
  return { ok: true as const, status: 200 as const, data: { activeUnitCount } };
}

// ── Claims ──────────────────────────────────────────────────────────────────

export async function listClaimsService(
  session: CommissionsSession,
  filters: {
    agentPartyId?: string; status?: string; claimType?: string;
    dateField?: "createdAt" | "salesDate" | "moveInDate";
    dateFrom?: string; dateTo?: string; search?: string;
    sort?: "newest" | "oldest" | "updated" | "status" | "claimType";
    page?: number; limit?: number;
  } = {},
) {
  const role = (session.role as AdminRole) ?? "editor";
  const result = await listClaims(session.orgId, filters, role);
  const canSee = canSeeCommission(role);
  return {
    ok: true as const,
    status: 200,
    data: {
      data: result.data.map((c) => {
        const base = {
          id: c.id,
          claimNumber: c.claimNumber,
          agentName: c.agent.displayName,
          claimType: c.claimType,
          submittedAt: c.submittedAt?.toISOString() ?? c.createdAt.toISOString(),
          currency: c.currency,
          status: c.status,
        };
        // Editors never see commission amounts. The field is absent
        // from the row at the Prisma select layer — this is a belt-and-
        // braces check so a map refactor can't silently re-expose it.
        if (!canSee) return base;
        return { ...base, totalNettPayout: Number(c.totalNettPayout) };
      }),
      pagination: { page: result.page, limit: result.limit, total: result.total },
    },
  };
}

export async function getClaimDetailService(session: CommissionsSession, claimId: string) {
  const role = (session.role as AdminRole) ?? "editor";
  const claim = await findClaim(session.orgId, claimId, role);
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };

  const canSee = canSeeCommission(role);

  // Editors get a minimal shape: identity + status + agent contact only.
  // Commission amounts, items, and bank-account details are absent from
  // both the Prisma select and the mapped output.
  // `agentPhone` is canonical (60XXXXXXXXX) and `formattedAgentPhone` is
  // the friendly display form ("+60 12-345 6789") — pre-rendered so the
  // claim detail page renders the friendly variant without bundling
  // libphonenumber-js into the client.
  const canonicalAgentPhone = readPhoneAnyFormat(claim.agent.primaryPhone);
  const base = {
    id: claim.id,
    claimNumber: claim.claimNumber,
    status: claim.status,
    currency: claim.currency,
    claimType: claim.claimType,
    submittedAt: claim.submittedAt?.toISOString() ?? null,
    approvedAt: claim.approvedAt?.toISOString() ?? null,
    paidAt: claim.paidAt?.toISOString() ?? null,
    agentName: claim.agent.displayName,
    agentEmail: claim.agent.primaryEmail,
    agentPhone: canonicalAgentPhone,
    formattedAgentPhone: canonicalAgentPhone ? formatMyPhoneDisplay(canonicalAgentPhone) : null,
  };

  if (!canSee) {
    return { ok: true as const, status: 200, data: base };
  }

  // Manager+ — full shape including items and commission amounts.
  // `claim.items` and `claim.totalNettPayout` are only defined on the
  // manager+ branch of the repository select.
  const claimFull = claim as typeof claim & {
    totalNettPayout: unknown;
    items: Array<{
      id: string;
      condoName: string;
      unitCode: string;
      roomType: string;
      tenantName: string;
      tenantEmail: string | null;
      tenantPhone: string | null;
      tenantLinkedinUrl: string | null;
      tenantInstagramHandle: string | null;
      tenantJobPosition: string | null;
      salesDate: Date;
      moveInDate: Date;
      moveOutDate: Date | null;
      monthlyRental: unknown;
      agentTierPercentage: unknown;
      commissionPercentage: unknown;
      tenancyChargesByAgent: unknown;
      tenancyChargesByKaen: unknown;
      numberOfPax: number | null;
      remark: string | null;
      nettPayout: unknown;
    }>;
  };

  const data = {
    ...base,
    // agentPartyId is needed by the PDF service (server-side puppeteer pipeline)
    // to enforce agent self-only auth when the same service backs both admin
    // and agent-portal PDF download routes.
    agentPartyId: claim.agentPartyId,
    totalNettPayout: Number(claimFull.totalNettPayout),
    bankName: claim.agent.bankName,
    bankAccountHolder: claim.agent.bankAccountHolder,
    bankAccountNumber: claim.agent.bankAccountNumber ?? null,
    items: claimFull.items.map((item) => {
      // Mirror portal getClaimService: read-tolerant canonical + pre-formatted
      // display variant so the admin claim-detail page renders without parsing
      // libphonenumber-js client-side, and tolerates legacy `+60`-formatted rows.
      const canonicalTenantPhone = readPhoneAnyFormat(item.tenantPhone);
      return {
        id: item.id,
        condoName: item.condoName,
        unitCode: item.unitCode,
        roomType: item.roomType,
        tenantName: item.tenantName,
        tenantEmail: item.tenantEmail ?? null,
        tenantPhone: canonicalTenantPhone,
        formattedTenantPhone: canonicalTenantPhone ? formatMyPhoneDisplay(canonicalTenantPhone) : null,
        tenantLinkedinUrl: item.tenantLinkedinUrl ?? null,
        tenantInstagramHandle: item.tenantInstagramHandle ?? null,
        tenantJobPosition: item.tenantJobPosition ?? null,
        salesDate: item.salesDate.toISOString(),
        moveInDate: item.moveInDate.toISOString(),
        moveOutDate: item.moveOutDate ? item.moveOutDate.toISOString() : null,
        monthlyRental: Number(item.monthlyRental),
        agentTierPercentage: item.agentTierPercentage != null ? Number(item.agentTierPercentage) : null,
        commissionPercentage: Number(item.commissionPercentage),
        tenancyChargesByAgent: Number(item.tenancyChargesByAgent),
        tenancyChargesByKaen: Number(item.tenancyChargesByKaen),
        numberOfPax: item.numberOfPax,
        remark: item.remark,
        nettPayout: Number(item.nettPayout),
      };
    }),
  };

  return { ok: true as const, status: 200, data };
}

// ── Approve ─────────────────────────────────────────────────────────────────

export async function approveClaimService(
  session: CommissionsSession,
  claimId: string,
  input: { dueDate?: string },
) {
  // Approve/reject/pay/undo flows are route-gated to manager+; they always
  // need the full claim shape (totalNettPayout, billId, etc.).
  const claim = await findClaim(session.orgId, claimId, "admin");
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  if (claim.status !== "submitted") return { ok: false as const, status: 409, error: "Claim is not in submitted status" };

  const db = getDb();

  const billNumber = await generateBillNumber(session.orgId);

  await db.$transaction(async (tx) => {
    const bill = await tx.commissionBill.create({
      data: {
        organizationId: session.orgId,
        billNumber,
        partyId: claim.agentPartyId,
        propertyId: null,
        category: "commission",
        description: `Commission claim ${claim.claimNumber}`,
        amount: claim.totalNettPayout,
        currency: claim.currency,
        status: "pending",
        ...(input.dueDate ? { dueDate: new Date(input.dueDate) } : {}),
      },
    });

    await tx.commissionClaim.update({
      where: { id: claimId },
      data: {
        status: "approved",
        billId: bill.id,
        approvedAt: new Date(),
        approvedBy: session.userId,
      },
    });

    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "commission_claim",
        entityId: claimId,
        action: "approved",
        description: `Claim ${claim.claimNumber} approved`,
        performedBy: session.userId,
        metadata: { billNumber, claimNumber: claim.claimNumber },
      },
    });
  });

  return { ok: true as const, status: 200, data: { id: claimId } };
}

// ── Reject ──────────────────────────────────────────────────────────────────

export async function rejectClaimService(
  session: CommissionsSession,
  claimId: string,
  input: { reason: string },
) {
  const claim = await findClaim(session.orgId, claimId, "admin");
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  // Reject is allowed from submitted (first review) AND amended (post-resubmit
  // review). Any earlier Bill side-effect was reversed at the send-back step
  // (see sendBackForAmendmentService), so reject from amended is purely a
  // status-and-audit-log operation.
  if (claim.status !== "submitted" && claim.status !== "amended") {
    return { ok: false as const, status: 409, error: "Claim cannot be rejected from its current status" };
  }

  const db = getDb();

  await db.commissionClaim.update({
    where: { id: claimId },
    data: {
      status: "rejected",
      rejectedAt: new Date(),
      rejectedBy: session.userId,
      rejectionReason: input.reason,
    },
  });

  await db.activityLog.create({
    data: {
      organizationId: session.orgId,
      entityType: "commission_claim",
      entityId: claimId,
      action: "rejected",
      description: `Claim ${claim.claimNumber} rejected: ${input.reason}`,
      performedBy: session.userId,
      metadata: { reason: input.reason, claimNumber: claim.claimNumber },
    },
  });

  return { ok: true as const, status: 200, data: { id: claimId } };
}

// ── Pay ─────────────────────────────────────────────────────────────────────

async function generateMovementNumber(orgId: string): Promise<string> {
  const db = getDb();
  const year = new Date().getFullYear();
  const prefix = `CM-${year}-`;
  const latest = await db.cashMovement.findFirst({
    where: { organizationId: orgId, movementNumber: { startsWith: prefix } },
    orderBy: { movementNumber: "desc" },
    select: { movementNumber: true },
  });
  const lastSeq = latest ? (parseInt(latest.movementNumber.slice(prefix.length), 10) || 0) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
}

export async function payClaimService(
  session: CommissionsSession,
  claimId: string,
  input: { movementDate: string; paymentTender: string; notes?: string },
) {
  const claim = await findClaim(session.orgId, claimId, "admin");
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  if (claim.status !== "approved") return { ok: false as const, status: 409, error: "Claim is not in approved status" };

  const db = getDb();

  const movementNumber = await generateMovementNumber(session.orgId);

  await db.$transaction(async (tx) => {
    const cashMovement = await tx.cashMovement.create({
      data: {
        organizationId: session.orgId,
        movementNumber,
        type: "outflow",
        category: "commission",
        description: `Commission payment for claim ${claim.claimNumber}`,
        amount: claim.totalNettPayout,
        currency: claim.currency,
        partyId: claim.agentPartyId,
        movementDate: new Date(input.movementDate),
        paymentTender: input.paymentTender,
        allocatedAmount: claim.totalNettPayout,
        allocationStatus: "allocated",
        ...(input.notes ? { notes: input.notes } : {}),
      },
    });

    if (claim.billId) {
      await tx.commissionBill.update({
        where: { id: claim.billId },
        data: { status: "paid", paidAt: new Date() },
      });
    }

    await tx.commissionClaim.update({
      where: { id: claimId },
      data: {
        status: "paid",
        paidAt: new Date(),
        paidBy: session.userId,
        cashMovementId: cashMovement.id,
      },
    });

    // Auto-upgrade agent level if this payment crosses a threshold.
    // One-way — never demotes. See ./agent-level-upgrade.ts.
    await upgradeAgentLevelIfEligible(tx, {
      organizationId: session.orgId,
      agentPartyId: claim.agentPartyId,
      triggeredByClaimId: claim.id,
    });

    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "commission_claim",
        entityId: claimId,
        action: "paid",
        description: `Claim ${claim.claimNumber} marked as paid`,
        performedBy: session.userId,
        metadata: { movementNumber, claimNumber: claim.claimNumber },
      },
    });
  });

  return { ok: true as const, status: 200, data: { id: claimId } };
}

// ── Performance ─────────────────────────────────────────────────────────────

export async function getPerformanceService(session: CommissionsSession) {
  const db = getDb();

  const claims = await db.commissionClaim.findMany({
    where: { organizationId: session.orgId },
    include: { agent: { select: { id: true, displayName: true } } },
  });

  const agentMap = new Map<string, {
    id: string;
    agentName: string;
    totalEarned: number;
    pendingAmount: number;
    approvedAmount: number;
    paidAmount: number;
    claimCount: number;
    currency: string;
  }>();

  for (const claim of claims) {
    const agentId = claim.agentPartyId;
    if (!agentMap.has(agentId)) {
      agentMap.set(agentId, {
        id: agentId,
        agentName: claim.agent.displayName,
        totalEarned: 0,
        pendingAmount: 0,
        approvedAmount: 0,
        paidAmount: 0,
        claimCount: 0,
        currency: claim.currency,
      });
    }
    const entry = agentMap.get(agentId)!;
    const amount = Number(claim.totalNettPayout);
    entry.claimCount += 1;

    if (claim.status === "submitted") entry.pendingAmount += amount;
    else if (claim.status === "approved") {
      entry.approvedAmount += amount;
      entry.totalEarned += amount;
    } else if (claim.status === "paid") {
      entry.paidAmount += amount;
      entry.totalEarned += amount;
    }
  }

  return { ok: true as const, status: 200, data: Array.from(agentMap.values()) };
}

// ── Bulk Approve ─────────────────────────────────────────────────────────────


export async function bulkApproveClaimsService(
  session: CommissionsSession,
  input: { claimIds: string[] },
) {
  const requested = [...new Set(input.claimIds)];
  const claims = await findClaimsByIds(session.orgId, requested);
  const foundById = new Map(claims.map((c) => [c.id, c]));

  const approved: string[] = [];
  const failed: { claimId: string; reason: string; code?: string }[] = [];
  const rowsToCommit: Awaited<ReturnType<typeof findClaimsByIds>> = [];

  const db = getDb();

  for (const id of requested) {
    const claim = foundById.get(id);
    if (!claim) {
      failed.push({ claimId: id, reason: "Claim not found" });
      continue;
    }
    if (claim.status !== "submitted") {
      failed.push({ claimId: id, reason: `Claim is not in submitted status (current: ${claim.status})` });
      continue;
    }
    rowsToCommit.push(claim);
  }

  if (rowsToCommit.length > 0) {
    const withBillNumbers = [];
    for (const row of rowsToCommit) {
      withBillNumbers.push({
        claimId: row.id,
        claimNumber: row.claimNumber,
        agentPartyId: row.agentPartyId,
        totalNettPayout: Number(row.totalNettPayout),
        currency: row.currency,
        billNumber: await generateBillNumber(session.orgId),
      });
    }
    await bulkApproveTx(session.orgId, session.userId, withBillNumbers);
    approved.push(...withBillNumbers.map((r) => r.claimId));
  }

  return { ok: true as const, status: 200, data: { approved, failed } };
}

// ── Send back for amendment ─────────────────────────────────────────────────
// Admin can send a claim back to the agent for amendment from submitted,
// approved, or amended. Note is required (1..2000 chars after trim).
// For approved/amended → needs_amendment, the linked Bill is reversed
// inside the same transaction (3 lines inlined; the existing repo-layer
// undoApproveTx is too coupled to its own audit + status="submitted" to
// reuse here, and a 3-line duplication is below the rule-of-three threshold).

const NEEDS_AMENDMENT_SOURCE_STATES = new Set(["submitted", "approved", "amended"]);

export async function setClaimNeedsAmendmentService(
  session: CommissionsSession,
  claimId: string,
  input: { note: string },
) {
  const trimmed = input.note.trim();
  if (trimmed.length < 1) return { ok: false as const, status: 400, error: "Note is required" };
  if (trimmed.length > 2000) {
    return { ok: false as const, status: 400, error: "Note must be 2000 characters or fewer" };
  }

  const claim = await findClaim(session.orgId, claimId, "admin");
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  if (!NEEDS_AMENDMENT_SOURCE_STATES.has(claim.status)) {
    return {
      ok: false as const,
      status: 409,
      error: `Cannot send back claim in status '${claim.status}' for amendment`,
    };
  }

  const needsBillReversal = (claim.status === "approved" || claim.status === "amended") && claim.billId;

  const db = getDb();
  await db.$transaction(async (tx) => {
    if (needsBillReversal && claim.billId) {
      await tx.commissionBill.delete({ where: { id: claim.billId } });
    }
    await tx.commissionClaim.update({
      where: { id: claimId },
      data: {
        status: "needs_amendment",
        amendmentNote: trimmed,
        ...(needsBillReversal
          ? { billId: null, approvedAt: null, approvedBy: null }
          : {}),
      },
    });
    await tx.activityLog.create({
      data: {
        organizationId: session.orgId,
        entityType: "commission_claim",
        entityId: claimId,
        action: "needs_amendment",
        description: `Claim ${claim.claimNumber} sent back for amendment`,
        performedBy: session.userId,
        metadata: {
          fromStatus: claim.status,
          claimNumber: claim.claimNumber,
          noteLength: trimmed.length,
          billReversed: Boolean(needsBillReversal),
        },
      },
    });
  });

  return { ok: true as const, status: 200, data: { id: claimId, status: "needs_amendment" } };
}

// ── Undo Approve ─────────────────────────────────────────────────────────────

const UNDO_WINDOW_MS = 30_000;

export async function undoApproveClaimService(session: CommissionsSession, claimId: string) {
  const claim = await findClaim(session.orgId, claimId, "admin");
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  if (claim.status !== "approved") {
    return { ok: false as const, status: 409, error: `Claim is not in approved status (current: ${claim.status})` };
  }
  if (!claim.billId) return { ok: false as const, status: 409, error: "Claim has no linked bill to revert" };
  if (claim.approvedAt && Date.now() - new Date(claim.approvedAt).getTime() > UNDO_WINDOW_MS) {
    return { ok: false as const, status: 409, error: "Undo window expired" };
  }
  await undoApproveTx(session.orgId, session.userId, claim.id, claim.billId, claim.claimNumber);
  return { ok: true as const, status: 200, data: { id: claimId } };
}

// ── Re-approve (after amendment) ────────────────────────────────────────────
// Manager+ only. Transitions `amended` → `approved` via the shared
// state-machine (same registry the agent-side amend uses — single source of
// truth). Writes a `claim.re-approve` audit row inside the same transaction
// so the status flip and the audit trail are atomic.
//
// No Bill is created here — the Bill was minted at the original approve
// step and remains linked. A future iteration may recompute the bill amount
// when items changed during amendment; v1 preserves the existing bill
// linkage unchanged.

export async function reApproveClaimService(
  session: CommissionsSession,
  claimId: string,
  meta: { ip?: string; userAgent?: string } = {},
) {
  const role = (session.role as AdminRole) ?? "editor";
  const claim = await findClaim(session.orgId, claimId, role);
  if (!claim) return { ok: false as const, status: 404 as const, error: "Claim not found" };

  // Source-state gate. Re-approve is semantically distinct from the original
  // approve: it only accepts `amended` as the starting state. Submitted
  // claims use `/approve`; already-approved claims would be a no-op. We
  // short-circuit those here with a `forbidden_transition` error rather than
  // leaning on the state-machine (which permits `submitted → approved` as
  // the normal approve path for admin/manager).
  if (claim.status !== "amended") {
    return {
      ok: false as const,
      status: 403 as const,
      error: {
        code: "forbidden_transition" as const,
        message: `Transition ${claim.status} → approved not allowed for re-approve (source must be "amended").`,
        from: claim.status,
        to: "approved",
      },
    };
  }

  const db = getDb();

  // State-machine double-check — confirms the actor is authorized for the
  // `amended → approved` transition (keeps the state registry as the single
  // source of truth for who-can-do-what).
  try {
    assertTransition(claim.status as ClaimStatus, "approved", role as "admin" | "manager");
  } catch (err) {
    if (isClaimError(err)) {
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: err.toResponseBody().error,
      };
    }
    throw err;
  }

  await db.$transaction(async (tx) => {
    await tx.commissionClaim.update({
      where: { id: claimId },
      data: {
        status: "approved",
        approvedAt: new Date(),
        approvedBy: session.userId,
      },
    });

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: role,
      action: "claim.re-approve",
      entityType: "CommissionClaim",
      entityId: claimId,
      diff: { before: { status: claim.status }, after: { status: "approved" } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });

  return { ok: true as const, status: 200 as const, data: { id: claimId } };
}

// ── Rental Commission Claim PDF ────────────────────────────────────────────
//
// Server-side puppeteer pipeline that reuses the same document_template +
// renderToHtml + htmlToPdf path that produces reservation PDFs. The shared
// pipeline gives commission claims the same letterhead (logo, org info,
// tax IDs, address, ref#, date) without duplicating layout code.
//
// Used by BOTH the admin route (GET /commissions/claims/:id/pdf) and the
// agent-portal route (GET /portal-api/commissions/claims/:id/pdf). The
// service enforces agent self-only auth so the portal route can pass through
// without an additional check.

export async function getRentalCommissionClaimPdfService(
  session: CommissionsSession,
  claimId: string,
): Promise<
  | { ok: true; pdf: Buffer; filename: string; status: 200 }
  | { ok: false; error: string; status: 403 | 404 }
> {
  // Two data-fetch paths, one for each visibility model:
  //   - Agent role goes through the PORTAL service which handles owner +
  //     upline visibility (admin getClaimDetailService rejects 'agent' role
  //     because AdminRole = "admin" | "manager" | "editor" and
  //     canSeeCommission() requires manager+, so the agent gets the stripped
  //     base shape → no items → 403).
  //   - Admin/manager/editor goes through getClaimDetailService as before.
  //
  // The two paths return slightly different data shapes; we normalise into
  // FullClaimDetail before rendering.
  type FullClaimDetail = {
    claimNumber: string;
    submittedAt: string | null;
    approvedAt: string | null;
    agentName: string;
    agentPartyId: string;
    bankName: string | null;
    bankAccountHolder: string | null;
    bankAccountNumber: string | null;
    totalNettPayout: number;
    items: Array<{
      condoName: string;
      unitCode: string;
      roomType: string;
      tenantName: string;
      salesDate: string;
      moveInDate: string;
      moveOutDate: string | null;
      monthlyRental: number;
      tenancyChargesByAgent: number;
      tenancyChargesByKaen: number;
      numberOfPax: number | null;
      agentTierPercentage: number | null;
      commissionPercentage: number;
      nettPayout: number;
    }>;
  };

  let fullData: FullClaimDetail;

  if (session.role === "agent") {
    // Portal service: handles owner + upline visibility. Returns 404 if the
    // session's party can't see this claim.
    if (!session.partyId) {
      return { ok: false, error: "Not your claim", status: 403 };
    }
    const portalDetail = await getPortalClaimService(
      {
        userId: session.userId,
        orgId: session.orgId,
        userType: "agent",
        partyId: session.partyId,
        role: session.role,
      },
      claimId,
    );
    if (!portalDetail.ok) {
      return {
        ok: false,
        error: portalDetail.error,
        status: portalDetail.status as 403 | 404,
      };
    }
    fullData = portalDetail.data as unknown as FullClaimDetail;
  } else {
    // Admin/manager/editor path: existing service.
    const detail = await getClaimDetailService(session, claimId);
    if (!detail.ok) {
      return {
        ok: false,
        error: detail.error,
        status: detail.status as 403 | 404,
      };
    }
    // Editors get a stripped shape without items — they shouldn't be able to
    // download the PDF either. The presence of `items` on the detail shape is
    // the canonical signal that the caller has commission-data visibility.
    if (!("items" in detail.data)) {
      return {
        ok: false,
        error: "Insufficient permissions to download PDF",
        status: 403,
      };
    }
    fullData = detail.data as unknown as FullClaimDetail;
  }

  const template = await getTemplateForOrgDocType(
    session.orgId,
    "rental_commission_claim",
  );

  const bodyHtml = buildCommissionClaimBodyHtml({
    claimNumber: fullData.claimNumber,
    submittedAt: fullData.submittedAt,
    approvedAt: fullData.approvedAt,
    agentName: fullData.agentName,
    bankAccountHolder: fullData.bankAccountHolder ?? null,
    bankName: fullData.bankName ?? null,
    bankAccountNumber: fullData.bankAccountNumber ?? null,
    totalNettPayout: fullData.totalNettPayout,
    items: fullData.items.map((it) => ({
      condoName: it.condoName,
      unitCode: it.unitCode,
      roomType: it.roomType,
      tenantName: it.tenantName,
      salesDate: it.salesDate,
      moveInDate: it.moveInDate,
      moveOutDate: it.moveOutDate,
      monthlyRental: it.monthlyRental,
      tenancyChargesByAgent: it.tenancyChargesByAgent,
      tenancyChargesByKaen: it.tenancyChargesByKaen,
      numberOfPax: it.numberOfPax,
      agentTierPercentage: it.agentTierPercentage,
      commissionPercentage: it.commissionPercentage,
      nettPayout: it.nettPayout,
    })),
  });

  const html = renderToHtml({
    template,
    referenceCode: fullData.claimNumber,
    issuedDate: fullData.submittedAt
      ? new Date(fullData.submittedAt)
      : new Date(),
    bodyHtml,
    // No signature block — commission claim is internal accounting.
  });

  const pdf = await htmlToPdf(html);
  return {
    ok: true,
    pdf,
    filename: `${fullData.claimNumber}.pdf`,
    status: 200,
  };
}
