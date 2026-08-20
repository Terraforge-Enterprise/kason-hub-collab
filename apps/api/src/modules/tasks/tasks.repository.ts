import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { StaleUpdateError } from "../../lib/concurrency-error";

export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}

const TASK_INCLUDE = {
  relatedUnit: {
    select: {
      id: true,
      apartment: { select: { unitCode: true, property: { select: { name: true } } } },
    },
  },
} satisfies Prisma.TaskInclude;

export type DbTask = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export async function listTasks(
  orgId: string,
  filters: {
    status?: string;
    assigneeUserId?: string; // "unassigned" → null filter
    priority?: string;
    category?: string;
    relatedUnitId?: string;
    sprintId?: string; // "null" → IS NULL (Backlog); <uuid> → that sprint; omitted → all
  },
): Promise<DbTask[]> {
  const db = getDb();
  return db.task.findMany({
    where: {
      organizationId: orgId,
      ...(filters.status ? { status: filters.status } : { status: { not: "archived" } }),
      ...(filters.assigneeUserId === "unassigned"
        ? { assigneeUserId: null }
        : filters.assigneeUserId
          ? { assigneeUserId: filters.assigneeUserId }
          : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.relatedUnitId ? { relatedUnitId: filters.relatedUnitId } : {}),
      ...(filters.sprintId === "null"
        ? { sprintId: null }
        : filters.sprintId
          ? { sprintId: filters.sprintId }
          : {}),
    },
    include: TASK_INCLUDE,
    orderBy: [{ sortOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export async function findTask(orgId: string, taskId: string): Promise<DbTask | null> {
  const db = getDb();
  return db.task.findFirst({
    where: { id: taskId, organizationId: orgId },
    include: TASK_INCLUDE,
  });
}

/** In-transaction variant of findTask — used to re-read a row mid-tx (e.g. after renumberLane). */
export async function findTaskInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  taskId: string,
): Promise<DbTask | null> {
  return tx.task.findFirst({
    where: { id: taskId, organizationId: orgId },
    include: TASK_INCLUDE,
  });
}

export async function createTaskRow(
  tx: Prisma.TransactionClient,
  data: Prisma.TaskUncheckedCreateInput,
): Promise<DbTask> {
  return tx.task.create({ data, include: TASK_INCLUDE });
}

/**
 * Optimistic-concurrency guarded update: the WHERE carries both the org scope
 * and the expected `updatedAt`. `count === 0` means the row was modified (or
 * deleted) since the caller's read — surfaced as StaleUpdateError → 409.
 */
export async function updateTaskGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  taskId: string,
  expectedUpdatedAt: string,
  data: Prisma.TaskUncheckedUpdateManyInput,
): Promise<DbTask> {
  const result = await tx.task.updateMany({
    where: { id: taskId, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findTaskInTx(tx, orgId, taskId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/**
 * Re-number an entire lane after a drag-drop: fetch the lane's ids (excluding
 * the moving task), splice the moving id in at the clamped position, then
 * write contiguous sortOrders. Update-by-PK here is the sanctioned exception —
 * every id comes from the org-scoped read in the same tx.
 */
export async function renumberLane(
  tx: Prisma.TransactionClient,
  orgId: string,
  status: string,
  movingId: string,
  position: number,
): Promise<void> {
  const lane = await tx.task.findMany({
    where: { organizationId: orgId, status, id: { not: movingId } },
    select: { id: true },
    orderBy: [{ sortOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  const ids = lane.map((t) => t.id);
  const clamped = Math.max(0, Math.min(position, ids.length));
  ids.splice(clamped, 0, movingId);
  for (let i = 0; i < ids.length; i++) {
    await tx.task.update({ where: { id: ids[i]! }, data: { sortOrder: i } });
  }
}

export async function nextLaneSortOrder(
  tx: Prisma.TransactionClient,
  orgId: string,
  status: string,
): Promise<number> {
  const agg = await tx.task.aggregate({
    where: { organizationId: orgId, status },
    _max: { sortOrder: true },
  });
  return (agg._max.sortOrder ?? -1) + 1;
}

export async function findActiveOperator(
  orgId: string,
  userId: string,
): Promise<{ id: string; fullName: string } | null> {
  const db = getDb();
  return db.user.findFirst({
    where: { id: userId, organizationId: orgId, userType: "operator", status: "active" },
    select: { id: true, fullName: true },
  });
}

export async function getUsersByIds(
  orgId: string,
  ids: string[],
): Promise<Array<{ id: string; fullName: string; photoKey: string | null }>> {
  if (ids.length === 0) return [];
  const db = getDb();
  return db.user.findMany({
    where: { id: { in: ids }, organizationId: orgId },
    select: { id: true, fullName: true, photoKey: true },
  });
}

export async function findListing(
  orgId: string,
  listingId: string,
): Promise<{ id: string } | null> {
  const db = getDb();
  return db.listing.findFirst({
    where: { id: listingId, organizationId: orgId },
    select: { id: true },
  });
}

export async function findTicketById(
  orgId: string,
  ticketId: string,
): Promise<{ id: string; unitId: string; status: string } | null> {
  const db = getDb();
  return db.ticket.findFirst({
    where: { id: ticketId, organizationId: orgId },
    select: { id: true, unitId: true, status: true },
  });
}

export async function deleteTaskRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  taskId: string,
): Promise<void> {
  await tx.task.deleteMany({ where: { id: taskId, organizationId: orgId } });
}

/** Most-recent closed (done|archived) task paired to a ticket — the pull-back/revival target. */
export async function findClosedTaskByTicketId(
  tx: Prisma.TransactionClient,
  orgId: string,
  ticketId: string,
  status: "done" | "archived",
): Promise<{ id: string; assigneeUserId: string | null; startedAt: Date | null } | null> {
  return tx.task.findFirst({
    where: { organizationId: orgId, ticketId, status },
    select: { id: true, assigneeUserId: true, startedAt: true },
    orderBy: { updatedAt: "desc" },
  });
}

/** The single non-terminal task paired to a ticket (1:1 mirror). null if none/closed. */
export async function findOpenTaskByTicketId(
  tx: Prisma.TransactionClient,
  orgId: string,
  ticketId: string,
): Promise<{ id: string; status: string; startedAt: Date | null } | null> {
  return tx.task.findFirst({
    where: { organizationId: orgId, ticketId, status: { notIn: ["done", "archived"] } },
    select: { id: true, status: true, startedAt: true },
  });
}
