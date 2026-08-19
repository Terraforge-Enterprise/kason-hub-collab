import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

export type WorkCategoryRow = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function listWorkCategoriesRepo(orgId: string, opts?: { activeOnly?: boolean }): Promise<WorkCategoryRow[]> {
  return getDb().workCategory.findMany({
    where: { organizationId: orgId, ...(opts?.activeOnly ? { isActive: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function findWorkCategoryById(orgId: string, id: string): Promise<WorkCategoryRow | null> {
  return getDb().workCategory.findFirst({ where: { id, organizationId: orgId } });
}

/** Create within the caller's transaction so the row + its audit row commit/rollback together. */
export async function createWorkCategoryRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: { name: string; sortOrder: number },
): Promise<WorkCategoryRow> {
  return tx.workCategory.create({ data: { organizationId: orgId, name: input.name, sortOrder: input.sortOrder } });
}

/**
 * Org-scoped update within the caller's transaction. `organizationId` is
 * asserted on the WRITE itself (updateMany) — no TOCTOU window between a
 * separate org check and the update. Re-fetches via tx; null if nothing
 * matched (wrong org or missing id).
 */
export async function updateWorkCategoryRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<WorkCategoryRow | null> {
  const { count } = await tx.workCategory.updateMany({ where: { id, organizationId: orgId }, data: input });
  if (count === 0) return null;
  return tx.workCategory.findFirst({ where: { id, organizationId: orgId } });
}

/** Delete within the caller's transaction. Org-scoped on the write. */
export async function deleteWorkCategoryRow(tx: Prisma.TransactionClient, orgId: string, id: string): Promise<void> {
  // No array references (unlike Amenity); category is a free string on Ticket/Task.
  // Deleting the catalog row leaves existing Ticket.category/Task.category strings intact.
  await tx.workCategory.deleteMany({ where: { id, organizationId: orgId } });
}

export async function getWorkCategoryUsageRepo(orgId: string, name: string): Promise<{ ticketCount: number; taskCount: number }> {
  const [ticketCount, taskCount] = await Promise.all([
    getDb().ticket.count({ where: { organizationId: orgId, category: name } }),
    getDb().task.count({ where: { organizationId: orgId, category: name } }),
  ]);
  return { ticketCount, taskCount };
}
