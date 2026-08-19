import { Prisma, getDb } from "@kason/db";
import { recordAudit } from "../../../lib/audit";
import type { AdminRole } from "../../../lib/rbac";
import {
  type PropertyTypeRow,
  createPropertyTypeRow,
  deletePropertyTypeRow,
  findPropertyTypeById,
  getPropertyTypeUsageRepo,
  listPropertyTypesRepo,
  updatePropertyTypeRow,
} from "./property-types.repository";
import type { CreatePropertyTypeInput, UpdatePropertyTypeInput } from "./property-types.validation";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 404 | 409; error: { code: string; message: string } };

export interface PropertyTypeActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

const CONFLICT = { code: "property_type_name_conflict", message: "A property type with this name already exists." };
const NOT_FOUND = { code: "property_type_not_found", message: "Property type not found in this organization." };
const IN_USE = { code: "property_type_in_use", message: "Cannot delete a property type that is in use. Deactivate it instead." };

export async function listPropertyTypesService(orgId: string, opts?: { activeOnly?: boolean }): Promise<PropertyTypeRow[]> {
  return listPropertyTypesRepo(orgId, opts);
}

export async function createPropertyTypeService(ctx: PropertyTypeActorCtx, input: CreatePropertyTypeInput): Promise<Result<PropertyTypeRow>> {
  try {
    const row = await getDb().$transaction(async (tx) => {
      const created = await createPropertyTypeRow(tx, ctx.orgId, { name: input.name, sortOrder: input.sortOrder ?? 0 });
      await recordAudit(tx, {
        organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
        action: "inventory.propertytype.create", entityType: "PropertyType", entityId: created.id,
        diff: { after: created } as unknown as Prisma.InputJsonValue, ip: ctx.ip, userAgent: ctx.userAgent,
      });
      return created;
    });
    return { ok: true, data: row };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, status: 409, error: CONFLICT };
    throw e;
  }
}

export async function updatePropertyTypeService(ctx: PropertyTypeActorCtx, id: string, input: UpdatePropertyTypeInput): Promise<Result<PropertyTypeRow>> {
  try {
    const row = await getDb().$transaction(async (tx) => {
      const updated = await updatePropertyTypeRow(tx, ctx.orgId, id, input);
      if (!updated) return null;
      await recordAudit(tx, {
        organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
        action: "inventory.propertytype.update", entityType: "PropertyType", entityId: updated.id,
        diff: { after: updated } as unknown as Prisma.InputJsonValue, ip: ctx.ip, userAgent: ctx.userAgent,
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

export async function deletePropertyTypeService(ctx: PropertyTypeActorCtx, id: string): Promise<Result<{ deleted: true }>> {
  const existing = await findPropertyTypeById(ctx.orgId, id);
  if (!existing) return { ok: false, status: 404, error: NOT_FOUND };
  const usage = await getPropertyTypeUsageRepo(ctx.orgId, existing.name);
  if (usage.propertyCount > 0) return { ok: false, status: 409, error: IN_USE };
  await getDb().$transaction(async (tx) => {
    await deletePropertyTypeRow(tx, ctx.orgId, id);
    await recordAudit(tx, {
      organizationId: ctx.orgId, actorUserId: ctx.actorUserId, actorRole: ctx.actorRole,
      action: "inventory.propertytype.delete", entityType: "PropertyType", entityId: id,
      diff: { before: existing } as unknown as Prisma.InputJsonValue, ip: ctx.ip, userAgent: ctx.userAgent,
    });
  });
  return { ok: true, data: { deleted: true } };
}

export async function getPropertyTypeUsageService(orgId: string, id: string): Promise<Result<{ propertyCount: number }>> {
  const existing = await findPropertyTypeById(orgId, id);
  if (!existing) return { ok: false, status: 404, error: NOT_FOUND };
  const usage = await getPropertyTypeUsageRepo(orgId, existing.name);
  return { ok: true, data: usage };
}
