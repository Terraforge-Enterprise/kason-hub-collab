import { getDb, type Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { cascadeCancelClaimsOnSalesUnitTermination } from "../../lib/cascade-cancel-claims-on-sales-unit-termination";
import { atLeast, type AdminRole } from "../../lib/rbac";
import {
  appendRenovationTransition,
  approveSourcingRow,
  createPromotedUnit,
  createSalesUnitRow,
  findOrCreatePromotedProperty,
  findProjectByIdScoped,
  findRenovationProgress,
  findSalesUnitById,
  findSalesUnitByIdTx,
  findUnitNumberConflict,
  listRenovationTransitions,
  listSalesUnits,
  setAmendmentNote,
  setProjectPromotedPropertyId,
  setSalesUnitPromotedUnitId,
  updateSalesUnitRow,
  upsertRenovationProgress,
  withTransaction,
} from "./sales.repository";
import type {
  AmendmentInput,
  CreateSalesUnitInput,
  ListSalesUnitsQuery,
  RejectInput,
  RenovationProgressRow,
  RenovationStatusInput,
  RenovationTransitionRow,
  SalesUnitRow,
  UpdateSalesUnitInput,
} from "./sales.types";

type ServiceOk<T> = { ok: true; status: 200 | 201; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type SalesServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface SalesActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getSalesUnitsService(
  session: { orgId: string; role: string },
  filters?: ListSalesUnitsQuery & { agentPartyIdEq?: string },
): Promise<SalesServiceResult<SalesUnitRow[]>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listSalesUnits(session.orgId, filters);
  return { ok: true, status: 200, data };
}

export async function getSalesUnitByIdService(
  session: { orgId: string; role: string },
  id: string,
): Promise<SalesServiceResult<SalesUnitRow>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const row = await findSalesUnitById(session.orgId, id);
  if (!row) return { ok: false, status: 404, error: "Sales unit not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export async function createSalesUnitService(
  ctx: SalesActorCtx,
  input: CreateSalesUnitInput,
  options?: {
    agentPartyIdOverride?: string;
    // Server-forces inChargePartyId regardless of input. Portal callers
    // pass session.partyId so the creator becomes in-charge — see
    // unified-property-sourcing spec §3.1.
    inChargePartyIdOverride?: string;
    sourceFlag?: string;
    sourcingApproved?: boolean;
    auditAction?: string;
  },
): Promise<SalesServiceResult<SalesUnitRow>> {
  // Admin path requires manager+. Portal path injects agentPartyIdOverride.
  if (!options?.agentPartyIdOverride && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const project = await findProjectByIdScoped(ctx.orgId, input.projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  if (project.status !== "active") {
    return { ok: false, status: 400, error: "Project is not active" };
  }

  const conflict = await findUnitNumberConflict({
    organizationId: ctx.orgId,
    projectId: input.projectId,
    unitNumber: input.unitNumber,
  });
  if (conflict) return { ok: false, status: 409, error: "Unit number already exists for this project" };

  const agentPartyId = options?.agentPartyIdOverride ?? input.agentPartyId;
  if (!agentPartyId) {
    return { ok: false, status: 400, error: "agentPartyId is required" };
  }

  // Effective in-charge: when the override is set (portal create), the
  // creator IS the in-charge — we ignore whatever the body said. Admin
  // path defaults to the input value (admin can pick any party).
  const effectiveInChargePartyId =
    options?.inChargePartyIdOverride ?? input.inChargePartyId ?? null;

  const row = await withTransaction(async (tx) => {
    const created = await createSalesUnitRow(tx, {
      ...input,
      inChargePartyId: effectiveInChargePartyId,
      organizationId: ctx.orgId,
      agentPartyId,
      sourceFlag: options?.sourceFlag,
      sourcingApproved: options?.sourcingApproved,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options?.auditAction ?? "sales.unit.create",
      entityType: "SalesUnit",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  });
  return { ok: true, status: 201, data: row };
}

export async function updateSalesUnitService(
  ctx: SalesActorCtx,
  id: string,
  input: UpdateSalesUnitInput,
  options?: {
    // portal-edit-after-approval rebound
    rebindOnApproval?: boolean;
    auditAction?: string;
    requireOwnerPartyId?: string;
  },
): Promise<SalesServiceResult<SalesUnitRow>> {
  // Admin path requires manager+. Portal path passes requireOwnerPartyId.
  if (!options?.requireOwnerPartyId && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  const preCheck = await findSalesUnitById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales unit not found" };

  // Portal: ownership check (only the submitting agent can edit).
  if (options?.requireOwnerPartyId && preCheck.agentPartyId !== options.requireOwnerPartyId) {
    return { ok: false, status: 404, error: "Sales unit not found" };
  }

  // Composite-key conflict guard if unit number / project changes.
  if (input.unitNumber || input.projectId) {
    const conflict = await findUnitNumberConflict({
      organizationId: ctx.orgId,
      projectId: input.projectId ?? preCheck.projectId,
      unitNumber: input.unitNumber ?? preCheck.unitNumber,
      excludeId: id,
    });
    if (conflict) return { ok: false, status: 409, error: "Unit number already exists for this project" };
  }

  const result = await withTransaction(async (tx) => {
    const before = await findSalesUnitByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    if (options?.requireOwnerPartyId && before.agentPartyId !== options.requireOwnerPartyId) {
      return null;
    }

    // Edit-after-approval rebound: portal edit on an approved row drops it
    // back to pending review. Plan §6.2.
    let extra: Parameters<typeof updateSalesUnitRow>[3] = {};
    if (options?.rebindOnApproval && before.sourcingApproved) {
      extra = {
        sourcingApproved: false,
        amendmentNotes: "Edited by agent post-approval",
        sourcingApprovedById: null,
        sourcingApprovedAt: null,
      };
    }

    const updated = await updateSalesUnitRow(tx, id, ctx.orgId, { ...input, ...extra });

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: options?.auditAction ?? "sales.unit.update",
      entityType: "SalesUnit",
      entityId: id,
      diff: { before, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });

  if (!result) return { ok: false, status: 404, error: "Sales unit not found" };
  return { ok: true, status: 200, data: result };
}

// ─── Source queue ────────────────────────────────────────────────────────────

export async function listSourceQueueService(
  ctx: SalesActorCtx,
): Promise<SalesServiceResult<SalesUnitRow[]>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const data = await listSalesUnits(ctx.orgId, { sourcingApproved: false });
  return { ok: true, status: 200, data };
}

/**
 * Withdraw a pending agent-sourced sales unit. Soft-delete via
 * sourcingCancelled (row stays for audit). Per unified-property-sourcing
 * spec §3.4 / Q1 resolution.
 *
 * Two callers:
 *   - Portal (agent): own unit, must still be pending. requireOwnerPartyId
 *     is set by the route handler.
 *   - Admin (manager+): any non-approved unit in their org. requireOwner
 *     is omitted.
 */
export async function cancelSalesUnitSourcingService(
  ctx: SalesActorCtx,
  unitId: string,
  options: { requireOwnerPartyId?: string } = {},
): Promise<
  | { ok: true; status: 200; data: { id: string } }
  | { ok: false; status: 403 | 404 | 409; error: string }
> {
  if (!options.requireOwnerPartyId && !atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const db = getDb();
  const existing = await db.salesUnit.findFirst({
    where: { id: unitId, organizationId: ctx.orgId },
    select: {
      id: true,
      agentPartyId: true,
      sourcingApproved: true,
      sourcingCancelled: true,
    },
  });
  if (!existing) return { ok: false, status: 404, error: "Sales unit not found" };
  if (
    options.requireOwnerPartyId &&
    existing.agentPartyId !== options.requireOwnerPartyId
  ) {
    // Wrong owner — same 404 (don't leak existence).
    return { ok: false, status: 404, error: "Sales unit not found" };
  }
  if (existing.sourcingApproved) {
    return {
      ok: false,
      status: 409,
      error: "Cannot withdraw — already approved",
    };
  }
  if (existing.sourcingCancelled) {
    return { ok: false, status: 409, error: "Already withdrawn" };
  }
  await withTransaction(async (tx) => {
    await tx.salesUnit.update({
      where: { id: unitId },
      data: { sourcingCancelled: true },
    });
    await cascadeCancelClaimsOnSalesUnitTermination(
      tx,
      unitId,
      "Sales Entry withdrawn by agent",
      ctx.actorUserId,
      ctx.orgId,
    );
  });
  return { ok: true, status: 200, data: { id: unitId } };
}

export async function approveSalesUnitService(
  ctx: SalesActorCtx,
  id: string,
): Promise<SalesServiceResult<SalesUnitRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findSalesUnitById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales unit not found" };
  if (preCheck.sourcingApproved) {
    return { ok: false, status: 409, error: "Sales unit already approved" };
  }

  const row = await withTransaction(async (tx) => {
    const before = await findSalesUnitByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    if (before.sourcingApproved) return null;
    const approved = await approveSourcingRow(tx, id, ctx.actorUserId, before.agentPartyId);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "sales.unit.sourcing.approve",
      entityType: "SalesUnit",
      entityId: id,
      diff: {
        before: { sourcingApproved: false, inChargePartyId: before.inChargePartyId },
        after: {
          sourcingApproved: true,
          inChargePartyId: before.agentPartyId,
        },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return approved;
  });

  if (!row) return { ok: false, status: 409, error: "Sales unit already approved" };
  return { ok: true, status: 200, data: row };
}

export async function rejectSalesUnitService(
  ctx: SalesActorCtx,
  id: string,
  input: RejectInput,
): Promise<SalesServiceResult<SalesUnitRow>> {
  return amendOrRejectInternal(ctx, id, input.note, "sales.unit.sourcing.reject");
}

export async function needsAmendmentSalesUnitService(
  ctx: SalesActorCtx,
  id: string,
  input: AmendmentInput,
): Promise<SalesServiceResult<SalesUnitRow>> {
  return amendOrRejectInternal(ctx, id, input.note, "sales.unit.sourcing.needs_amendment");
}

async function amendOrRejectInternal(
  ctx: SalesActorCtx,
  id: string,
  note: string,
  auditAction: string,
): Promise<SalesServiceResult<SalesUnitRow>> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findSalesUnitById(ctx.orgId, id);
  if (!preCheck) return { ok: false, status: 404, error: "Sales unit not found" };

  const row = await withTransaction(async (tx) => {
    const before = await findSalesUnitByIdTx(tx, ctx.orgId, id);
    if (!before) return null;
    const updated = await setAmendmentNote(tx, id, note);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: auditAction,
      entityType: "SalesUnit",
      entityId: id,
      diff: {
        before: { amendmentNotes: before.amendmentNotes },
        after: { amendmentNotes: note },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (auditAction === "sales.unit.sourcing.reject") {
      await cascadeCancelClaimsOnSalesUnitTermination(
        tx,
        id,
        `Source-queue rejected: ${note}`,
        ctx.actorUserId,
        ctx.orgId,
      );
    }
    return updated;
  });
  if (!row) return { ok: false, status: 404, error: "Sales unit not found" };
  return { ok: true, status: 200, data: row };
}

// ─── Renovation status + auto-promote ────────────────────────────────────────

export async function setRenovationStatusService(
  ctx: SalesActorCtx,
  salesUnitId: string,
  input: RenovationStatusInput,
): Promise<
  SalesServiceResult<{
    progress: RenovationProgressRow;
    salesUnit: SalesUnitRow;
    promotedUnitId: string | null;
  }>
> {
  if (!atLeast(ctx.actorRole, "manager")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const preCheck = await findSalesUnitById(ctx.orgId, salesUnitId);
  if (!preCheck) return { ok: false, status: 404, error: "Sales unit not found" };

  const result = await withTransaction(async (tx) => {
    const before = await findRenovationProgress(tx, salesUnitId);
    const fromStatus = before?.status ?? null;
    const progress = await upsertRenovationProgress(tx, {
      organizationId: ctx.orgId,
      salesUnitId,
      status: input.status,
      startDate: input.startDate ? new Date(input.startDate) : null,
      expectedCompletion: input.expectedCompletion
        ? new Date(input.expectedCompletion)
        : null,
      actualCompletion: input.actualCompletion ? new Date(input.actualCompletion) : null,
      notes: input.note ?? null,
      updatedById: ctx.actorUserId,
    });

    if (fromStatus !== input.status) {
      await appendRenovationTransition(tx, {
        organizationId: ctx.orgId,
        progressId: progress.id,
        fromStatus,
        toStatus: input.status,
        changedById: ctx.actorUserId,
        note: input.note ?? null,
      });
    }

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "sales.renovation.update",
      entityType: "SalesUnit",
      entityId: salesUnitId,
      diff: {
        before: { status: fromStatus },
        after: { status: input.status },
      } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // Auto-promote trigger: completion + purpose=rent + not already promoted.
    let promotedUnitId: string | null = null;
    const salesUnitNow = await findSalesUnitByIdTx(tx, ctx.orgId, salesUnitId);
    if (
      input.status === "completed" &&
      salesUnitNow &&
      salesUnitNow.purpose === "rent" &&
      !salesUnitNow.promotedUnitId
    ) {
      promotedUnitId = await autoPromoteSalesUnitInTx(tx, ctx, salesUnitNow);
    }

    const finalSalesUnit = await findSalesUnitByIdTx(tx, ctx.orgId, salesUnitId);
    return { progress, salesUnit: finalSalesUnit ?? preCheck, promotedUnitId };
  });

  return { ok: true, status: 200, data: result };
}

export async function getRenovationTransitionsService(
  session: { orgId: string; role: string },
  salesUnitId: string,
): Promise<SalesServiceResult<RenovationTransitionRow[]>> {
  const role = session.role as AdminRole;
  if (!atLeast(role, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const sales = await findSalesUnitById(session.orgId, salesUnitId);
  if (!sales) return { ok: false, status: 404, error: "Sales unit not found" };
  const data = await listRenovationTransitions(session.orgId, salesUnitId);
  return { ok: true, status: 200, data };
}

/**
 * Internal helper — invoked by `setRenovationStatusService` when a SalesUnit
 * with `purpose=rent` flips its renovation status to `completed`. Idempotent
 * via `salesUnit.promotedUnitId` guard. Plan §6.1.
 *
 * Property reuse: if the parent Project already has `promotedPropertyId`,
 * reuse it; otherwise mint a new Property scoped by the project's metadata
 * and back-fill `project.promotedPropertyId` so subsequent units land in the
 * same Property.
 *
 * Returns the new `Unit.id`. Caller must run inside an outer transaction.
 */
export async function autoPromoteSalesUnitInTx(
  tx: Prisma.TransactionClient,
  ctx: SalesActorCtx,
  salesUnit: SalesUnitRow,
): Promise<string | null> {
  if (salesUnit.promotedUnitId) return null; // idempotent guard

  const project = await tx.project.findUnique({
    where: { id: salesUnit.projectId },
    select: { id: true, name: true, city: true, promotedPropertyId: true, organizationId: true },
  });
  if (!project || project.organizationId !== ctx.orgId) return null;

  let propertyId = project.promotedPropertyId;
  if (!propertyId) {
    const property = await findOrCreatePromotedProperty(tx, {
      organizationId: ctx.orgId,
      projectId: project.id,
      name: project.name,
      city: project.city,
    });
    propertyId = property.id;
    await setProjectPromotedPropertyId(tx, project.id, propertyId);
  }

  // SalesUnit uses bedrooms=-1 for Studio; Unit table convention is 0.
  // Map at the service boundary so the contract handed to the repo helper
  // is always the Unit-table shape.
  const mappedBedrooms = salesUnit.bedrooms === -1 ? 0 : salesUnit.bedrooms;

  const created = await createPromotedUnit(tx, {
    organizationId: ctx.orgId,
    propertyId,
    unitCode: salesUnit.unitNumber,
    bedrooms: mappedBedrooms,
    bathrooms: salesUnit.bathrooms,
    expectedRental: salesUnit.expectedRental,
    inChargePartyId: salesUnit.inChargePartyId,
    sourcingAgentId: salesUnit.agentPartyId,
    salesUnitId: salesUnit.id,
  });

  await setSalesUnitPromotedUnitId(tx, salesUnit.id, created.id);

  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "sales.unit.auto_promote",
    entityType: "SalesUnit",
    entityId: salesUnit.id,
    diff: {
      after: { promotedUnitId: created.id, propertyId },
    } as unknown as Prisma.InputJsonValue,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return created.id;
}
