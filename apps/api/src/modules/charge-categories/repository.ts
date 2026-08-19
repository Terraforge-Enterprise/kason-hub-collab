// apps/api/src/modules/charge-categories/repository.ts
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

/** Serialized Decimal — same duck-type dodge billing.repository.ts uses. */
type DecimalLike = { toString(): string };

export type ChargeCategoryRecord = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  family: string;
  docType: string;
  seriesId: string;
  defaultSstRate: DecimalLike;
  eInvoiceEligible: boolean;
  ledgerCategory: string | null;
  isSystem: boolean;
  active: boolean;
  sortOrder: number;
  description: string | null;
  profitExpense: string | null;
  createdAt: Date;
  updatedAt: Date;
  series: { code: string };
};

export type DocumentSeriesRecord = {
  id: string;
  organizationId: string;
  code: string;
  prefix: string;
  padding: number;
  includeYear: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const CATEGORY_INCLUDE = { series: { select: { code: true } } } as const;

export async function listChargeCategoriesRepo(
  orgId: string,
  opts?: { includeInactive?: boolean },
): Promise<ChargeCategoryRecord[]> {
  return getDb().chargeCategory.findMany({
    where: { organizationId: orgId, ...(opts?.includeInactive ? {} : { active: true }) },
    include: CATEGORY_INCLUDE,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function findChargeCategoryByIdRepo(orgId: string, id: string): Promise<ChargeCategoryRecord | null> {
  return getDb().chargeCategory.findFirst({ where: { id, organizationId: orgId }, include: CATEGORY_INCLUDE });
}

/** Create within the caller's tx so row + audit commit/rollback together. */
export async function createChargeCategoryRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: {
    code: string;
    name: string;
    family: string;
    docType: string;
    seriesId: string;
    defaultSstRate: string;
    eInvoiceEligible: boolean;
    ledgerCategory: string | null;
    sortOrder: number;
    description: string | null;
    profitExpense: string | null;
  },
): Promise<ChargeCategoryRecord> {
  return tx.chargeCategory.create({ data: { organizationId: orgId, ...data }, include: CATEGORY_INCLUDE });
}

/**
 * Org-scoped guarded update: `updatedAt` equality in the WHERE is the
 * optimistic-concurrency token (same guarded-update pattern owner-ledger uses).
 * count === 0 ⇒ stale token (caller pre-checks existence → 409).
 */
export async function guardedUpdateChargeCategory(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  expectedUpdatedAt: string,
  data: {
    name?: string;
    family?: string;
    docType?: string;
    seriesId?: string;
    defaultSstRate?: string;
    eInvoiceEligible?: boolean;
    ledgerCategory?: string | null;
    active?: boolean;
    sortOrder?: number;
    description?: string | null;
    profitExpense?: string | null;
  },
): Promise<ChargeCategoryRecord | null> {
  const { count } = await tx.chargeCategory.updateMany({
    where: { id, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (count === 0) return null;
  return tx.chargeCategory.findFirst({ where: { id, organizationId: orgId }, include: CATEGORY_INCLUDE });
}

/** Deactivate (no token — POST /:id/deactivate carries none per contract). */
export async function deactivateChargeCategoryRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<ChargeCategoryRecord | null> {
  const { count } = await tx.chargeCategory.updateMany({
    where: { id, organizationId: orgId },
    data: { active: false },
  });
  if (count === 0) return null;
  return tx.chargeCategory.findFirst({ where: { id, organizationId: orgId }, include: CATEGORY_INCLUDE });
}

export async function listDocumentSeriesRepo(orgId: string): Promise<DocumentSeriesRecord[]> {
  return getDb().documentSeries.findMany({
    where: { organizationId: orgId },
    orderBy: [{ code: "asc" }],
  });
}

export async function findDocumentSeriesByIdRepo(orgId: string, id: string): Promise<DocumentSeriesRecord | null> {
  return getDb().documentSeries.findFirst({ where: { id, organizationId: orgId } });
}

export async function guardedUpdateDocumentSeries(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  expectedUpdatedAt: string,
  data: { prefix?: string; padding?: number; includeYear?: boolean; active?: boolean },
): Promise<DocumentSeriesRecord | null> {
  const { count } = await tx.documentSeries.updateMany({
    where: { id, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (count === 0) return null;
  return tx.documentSeries.findFirst({ where: { id, organizationId: orgId } });
}
