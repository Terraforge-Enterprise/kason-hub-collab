import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { atLeast, type AdminRole } from "../../lib/rbac";
import {
  createLabelRow,
  deleteLabelRow,
  findLabelByCategoryKeyConflict,
  findLabelById,
  findLabelByIdTx,
  listLabels,
  updateLabelRow,
  withTransaction,
} from "./renovation-settings.repository";
import type {
  CreateLabelInput,
  GroupedLabels,
  SettingsLabelRow,
  UpdateLabelInput,
} from "./renovation-settings.types";

type ServiceOk<T> = { ok: true; status: 200 | 201 | 204; data: T };
type ServiceErr = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type RenovationSettingsServiceResult<T> = ServiceOk<T> | ServiceErr;

export interface RenovationSettingsActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

/**
 * GET — every label in the org, grouped by category and sorted by
 * `sortOrder`. The repository already returns rows sorted, so this
 * function just buckets them.
 */
export async function listLabelsService(
  ctx: RenovationSettingsActorCtx,
): Promise<RenovationSettingsServiceResult<GroupedLabels>> {
  if (!atLeast(ctx.actorRole, "editor")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const rows = await listLabels(ctx.orgId);
  const grouped: GroupedLabels = {
    claim_status: [],
    renovation_status: [],
    document_kind: [],
    payment_type: [],
  };
  for (const row of rows) {
    // Categories outside the four enum values are ignored. They cannot be
    // created via this module's writes (Zod), but a manual DB write could
    // still seed an unknown category — fail open by skipping rather than
    // breaking the entire response.
    if (row.category in grouped) {
      grouped[row.category].push(row);
    }
  }
  return { ok: true, status: 200, data: grouped };
}

export async function createLabelService(
  ctx: RenovationSettingsActorCtx,
  input: CreateLabelInput,
): Promise<RenovationSettingsServiceResult<SettingsLabelRow>> {
  if (!atLeast(ctx.actorRole, "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const conflict = await findLabelByCategoryKeyConflict({
    organizationId: ctx.orgId,
    category: input.category,
    key: input.key,
  });
  if (conflict) {
    return {
      ok: false,
      status: 409,
      error: "Settings label already exists for this category and key",
    };
  }

  const row = await withTransaction(async (tx) => {
    const created = await createLabelRow(tx, {
      organizationId: ctx.orgId,
      category: input.category,
      key: input.key,
      label: input.label,
      sortOrder: input.sortOrder ?? 0,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.label.create",
      entityType: "SettingsLabel",
      entityId: created.id,
      diff: { after: created } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  });
  return { ok: true, status: 201, data: row };
}

export async function updateLabelService(
  ctx: RenovationSettingsActorCtx,
  id: string,
  input: UpdateLabelInput,
): Promise<RenovationSettingsServiceResult<SettingsLabelRow>> {
  if (!atLeast(ctx.actorRole, "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const before = await findLabelById(ctx.orgId, id);
  if (!before) {
    return { ok: false, status: 404, error: "Settings label not found" };
  }

  const row = await withTransaction(async (tx) => {
    const fresh = await findLabelByIdTx(tx, ctx.orgId, id);
    if (!fresh) return null;
    const updated = await updateLabelRow(tx, id, ctx.orgId, {
      label: input.label,
      sortOrder: input.sortOrder,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.label.update",
      entityType: "SettingsLabel",
      entityId: id,
      diff: { before: fresh, after: updated } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });
  if (!row) {
    return { ok: false, status: 404, error: "Settings label not found" };
  }
  return { ok: true, status: 200, data: row };
}

export async function deleteLabelService(
  ctx: RenovationSettingsActorCtx,
  id: string,
): Promise<RenovationSettingsServiceResult<{ id: string }>> {
  if (!atLeast(ctx.actorRole, "admin")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const before = await findLabelById(ctx.orgId, id);
  if (!before) {
    return { ok: false, status: 404, error: "Settings label not found" };
  }

  await withTransaction(async (tx) => {
    await deleteLabelRow(tx, id, ctx.orgId);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "renovation.label.delete",
      entityType: "SettingsLabel",
      entityId: id,
      diff: { before } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });
  return { ok: true, status: 200, data: { id } };
}
