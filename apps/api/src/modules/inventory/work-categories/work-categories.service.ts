import { Prisma, getDb } from "@kason/db";
import { recordAudit } from "../../../lib/audit";
import type { AdminRole } from "../../../lib/rbac";
import {
  type WorkCategoryRow,
  createWorkCategoryRow,
  deleteWorkCategoryRow,
  findWorkCategoryById,
  getWorkCategoryUsageRepo,
  listWorkCategoriesRepo,
  updateWorkCategoryRow,
} from "./work-categories.repository";
import type { CreateWorkCategoryInput, UpdateWorkCategoryInput } from "./work-categories.validation";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 404 | 409; error: { code: string; message: string } };

/** Actor context threaded from the route so every mutation audits in-tx. */
export interface WorkCategoryActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

const CONFLICT = { code: "category_name_conflict", message: "A category with this name already exists." };
const NOT_FOUND = { code: "category_not_found", message: "Category not found in this organization." };
const IN_USE = { code: "category_in_use", message: "Cannot delete a category that is in use. Deactivate it instead." };

export async function listWorkCategoriesService(orgId: string, opts?: { activeOnly?: boolean }): Promise<WorkCategoryRow[]> {
  return listWorkCategoriesRepo(orgId, opts);
}

export async function createWorkCategoryService(ctx: WorkCategoryActorCtx, input: CreateWorkCategoryInput): Promise<Result<WorkCategoryRow>> {
  try {
    const row = await getDb().$transaction(async (tx) => {
      const created = await createWorkCategoryRow(tx, ctx.orgId, { name: input.name, sortOrder: input.sortOrder ?? 0 });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "inventory.workcategory.create",
        entityType: "WorkCategory",
        entityId: created.id,
        diff: { after: created } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return created;
    });
    return { ok: true, data: row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, status: 409, error: CONFLICT };
    throw e;
  }
}

export async function updateWorkCategoryService(ctx: WorkCategoryActorCtx, id: string, input: UpdateWorkCategoryInput): Promise<Result<WorkCategoryRow>> {
  try {
    const row = await getDb().$transaction(async (tx) => {
      const updated = await updateWorkCategoryRow(tx, ctx.orgId, id, input);
      if (!updated) return null;
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "inventory.workcategory.update",
        entityType: "WorkCategory",
        entityId: updated.id,
        diff: { after: updated } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
    if (!row) return { ok: false, status: 404, error: NOT_FOUND };
    return { ok: true, data: row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, status: 409, error: CONFLICT };
    throw e;
  }
}

export async function deleteWorkCategoryService(ctx: WorkCategoryActorCtx, id: string): Promise<Result<{ deleted: true }>> {
  const existing = await findWorkCategoryById(ctx.orgId, id);
  if (!existing) return { ok: false, status: 404, error: NOT_FOUND };
  // Delete is "unused only": a category referenced by any ticket/task is retired
  // by deactivation (isActive=false), never a hard delete that orphans the label.
  const usage = await getWorkCategoryUsageRepo(ctx.orgId, existing.name);
  if (usage.ticketCount + usage.taskCount > 0) return { ok: false, status: 409, error: IN_USE };
  await getDb().$transaction(async (tx) => {
    await deleteWorkCategoryRow(tx, ctx.orgId, id);
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "inventory.workcategory.delete",
      entityType: "WorkCategory",
      entityId: id,
      diff: { before: existing } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  });
  return { ok: true, data: { deleted: true } };
}

export async function getWorkCategoryUsageService(orgId: string, id: string): Promise<Result<{ ticketCount: number; taskCount: number }>> {
  const existing = await findWorkCategoryById(orgId, id);
  if (!existing) return { ok: false, status: 404, error: NOT_FOUND };
  const usage = await getWorkCategoryUsageRepo(orgId, existing.name);
  return { ok: true, data: usage };
}
