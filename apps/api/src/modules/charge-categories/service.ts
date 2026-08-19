// apps/api/src/modules/charge-categories/service.ts
import { Prisma, getDb } from "@kason/db";
import type { ChargeCategoryDto, CategoryDocType, CategoryFamily, CreateChargeCategoryInput, DocumentSeriesDto, UpdateChargeCategoryInput, UpdateDocumentSeriesInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import type { AdminRole } from "../../lib/rbac";
import {
  type ChargeCategoryRecord,
  type DocumentSeriesRecord,
  createChargeCategoryRow,
  deactivateChargeCategoryRow,
  findChargeCategoryByIdRepo,
  findDocumentSeriesByIdRepo,
  guardedUpdateChargeCategory,
  guardedUpdateDocumentSeries,
  listChargeCategoriesRepo,
  listDocumentSeriesRepo,
} from "./repository";

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

/** Actor context threaded from the route so every mutation audits in-tx. */
export interface ChargeCategoryActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: AdminRole;
  ip?: string;
  userAgent?: string;
}

const CATEGORY_NOT_FOUND = { code: "CATEGORY_NOT_FOUND", message: "Category not found in this organization." };
const SERIES_NOT_FOUND = { code: "SERIES_NOT_FOUND", message: "Document series not found in this organization." };
const CATEGORY_CONFLICT = { code: "CATEGORY_CONFLICT", message: "A category with this code or name already exists." };
const CATEGORY_IS_SYSTEM = { code: "CATEGORY_IS_SYSTEM", message: "System categories cannot be deactivated — auto-post flows depend on them. Rename instead." };
const STALE_UPDATE = { code: "STALE_UPDATE", message: "This row changed since you loaded it — refresh and try again." };

function toCategoryDto(row: ChargeCategoryRecord): ChargeCategoryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    family: row.family as CategoryFamily,
    docType: row.docType as CategoryDocType,
    seriesId: row.seriesId,
    seriesCode: row.series.code,
    defaultSstRate: row.defaultSstRate.toString(),
    eInvoiceEligible: row.eInvoiceEligible,
    ledgerCategory: row.ledgerCategory,
    isSystem: row.isSystem,
    active: row.active,
    sortOrder: row.sortOrder,
    description: row.description,
    profitExpense: row.profitExpense as "profit" | "expense" | null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSeriesDto(row: DocumentSeriesRecord): DocumentSeriesDto {
  return {
    id: row.id,
    code: row.code,
    prefix: row.prefix,
    padding: row.padding,
    includeYear: row.includeYear,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listChargeCategoriesService(orgId: string, opts?: { includeInactive?: boolean }): Promise<ChargeCategoryDto[]> {
  const rows = await listChargeCategoriesRepo(orgId, opts);
  return rows.map(toCategoryDto);
}

export async function createChargeCategoryService(ctx: ChargeCategoryActorCtx, input: CreateChargeCategoryInput): Promise<Result<ChargeCategoryDto>> {
  const series = await findDocumentSeriesByIdRepo(ctx.orgId, input.seriesId);
  if (!series) return { ok: false, status: 400, error: SERIES_NOT_FOUND };
  try {
    const row = await getDb().$transaction(async (tx) => {
      const created = await createChargeCategoryRow(tx, ctx.orgId, {
        code: input.code,
        name: input.name,
        family: input.family,
        docType: input.docType,
        seriesId: input.seriesId,
        defaultSstRate: input.defaultSstRate ?? "0",
        eInvoiceEligible: input.eInvoiceEligible ?? false,
        ledgerCategory: input.ledgerCategory ?? null,
        sortOrder: input.sortOrder ?? 0,
        description: input.description ?? null,
        profitExpense: input.profitExpense ?? null,
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "billing.chargecategory.create",
        entityType: "ChargeCategory",
        entityId: created.id,
        diff: { after: { code: created.code, name: created.name, family: created.family, docType: created.docType } } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return created;
    });
    return { ok: true, data: toCategoryDto(row) };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, status: 409, error: CATEGORY_CONFLICT };
    }
    throw e;
  }
}

export async function updateChargeCategoryService(ctx: ChargeCategoryActorCtx, id: string, input: UpdateChargeCategoryInput): Promise<Result<ChargeCategoryDto>> {
  const existing = await findChargeCategoryByIdRepo(ctx.orgId, id);
  if (!existing) return { ok: false, status: 404, error: CATEGORY_NOT_FOUND };
  if (input.seriesId) {
    const series = await findDocumentSeriesByIdRepo(ctx.orgId, input.seriesId);
    if (!series) return { ok: false, status: 400, error: SERIES_NOT_FOUND };
  }
  const { expectedUpdatedAt, ...fields } = input;
  try {
    const row = await getDb().$transaction(async (tx) => {
      const updated = await guardedUpdateChargeCategory(tx, ctx.orgId, id, expectedUpdatedAt, fields);
      if (!updated) return null;
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "billing.chargecategory.update",
        entityType: "ChargeCategory",
        entityId: updated.id,
        diff: { before: { name: existing.name, active: existing.active }, after: fields } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
    if (!row) return { ok: false, status: 409, error: STALE_UPDATE };
    return { ok: true, data: toCategoryDto(row) };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, status: 409, error: CATEGORY_CONFLICT };
    }
    throw e;
  }
}

export async function deactivateChargeCategoryService(ctx: ChargeCategoryActorCtx, id: string): Promise<Result<ChargeCategoryDto>> {
  const existing = await findChargeCategoryByIdRepo(ctx.orgId, id);
  if (!existing) return { ok: false, status: 404, error: CATEGORY_NOT_FOUND };
  if (existing.isSystem) return { ok: false, status: 409, error: CATEGORY_IS_SYSTEM };
  const row = await getDb().$transaction(async (tx) => {
    const updated = await deactivateChargeCategoryRow(tx, ctx.orgId, id);
    if (!updated) return null;
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "billing.chargecategory.deactivate",
      entityType: "ChargeCategory",
      entityId: id,
      diff: { before: { active: existing.active }, after: { active: false } } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });
  if (!row) return { ok: false, status: 404, error: CATEGORY_NOT_FOUND };
  return { ok: true, data: toCategoryDto(row) };
}

export async function listDocumentSeriesService(orgId: string): Promise<DocumentSeriesDto[]> {
  const rows = await listDocumentSeriesRepo(orgId);
  return rows.map(toSeriesDto);
}

export async function updateDocumentSeriesService(ctx: ChargeCategoryActorCtx, id: string, input: UpdateDocumentSeriesInput): Promise<Result<DocumentSeriesDto>> {
  const existing = await findDocumentSeriesByIdRepo(ctx.orgId, id);
  if (!existing) return { ok: false, status: 404, error: SERIES_NOT_FOUND };
  const { expectedUpdatedAt, ...fields } = input;
  const row = await getDb().$transaction(async (tx) => {
    const updated = await guardedUpdateDocumentSeries(tx, ctx.orgId, id, expectedUpdatedAt, fields);
    if (!updated) return null;
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "billing.documentseries.update",
      entityType: "DocumentSeries",
      entityId: updated.id,
      diff: { before: { prefix: existing.prefix, padding: existing.padding, includeYear: existing.includeYear, active: existing.active }, after: fields } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  });
  if (!row) return { ok: false, status: 409, error: STALE_UPDATE };
  return { ok: true, data: toSeriesDto(row) };
}
