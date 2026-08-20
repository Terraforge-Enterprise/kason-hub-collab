import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { StaleUpdateError } from "../../lib/concurrency-error";

/** Re-export so the sprints module shares one transaction helper with tasks. */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.$transaction(fn);
}

export type DbSprint = Prisma.SprintGetPayload<object>;

export async function listSprints(
  orgId: string,
  filters: { status?: string },
): Promise<DbSprint[]> {
  const db = getDb();
  return db.sprint.findMany({
    where: {
      organizationId: orgId,
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { seq: "desc" },
  });
}

export async function findSprint(orgId: string, sprintId: string): Promise<DbSprint | null> {
  const db = getDb();
  return db.sprint.findFirst({ where: { id: sprintId, organizationId: orgId } });
}

/** In-transaction variant of findSprint — used to read the row mid-ceremony. */
export async function findSprintInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  sprintId: string,
): Promise<DbSprint | null> {
  return tx.sprint.findFirst({ where: { id: sprintId, organizationId: orgId } });
}

export async function createSprintRow(
  tx: Prisma.TransactionClient,
  data: Prisma.SprintUncheckedCreateInput,
): Promise<DbSprint> {
  return tx.sprint.create({ data });
}

/**
 * Optimistic-concurrency guarded update: the WHERE carries both the org scope
 * and the expected `updatedAt`. `count === 0` means the row was modified (or
 * deleted) since the caller's read — surfaced as StaleUpdateError → 409.
 */
export async function updateSprintGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  sprintId: string,
  expectedUpdatedAt: string,
  data: Prisma.SprintUncheckedUpdateManyInput,
): Promise<DbSprint> {
  const result = await tx.sprint.updateMany({
    where: { id: sprintId, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findSprintInTx(tx, orgId, sprintId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

/** Next per-org sprint number: max(seq) + 1, starting at 1. */
export async function nextSprintSeq(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<number> {
  const agg = await tx.sprint.aggregate({
    where: { organizationId: orgId },
    _max: { seq: true },
  });
  return (agg._max.seq ?? 0) + 1;
}

/**
 * Count this sprint's tasks by done-ness (§1.10). MUST tolerate no transaction:
 * read paths (list/get) call it with no tx → getDb(); the close ceremony passes
 * its tx. Never cast `tx as Prisma.TransactionClient` to silence the optional —
 * that hides the undefined-deref.
 */
export async function countSprintTasks(
  orgId: string,
  sprintId: string,
  opts: { done: boolean },
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const db = tx ?? getDb();
  return db.task.count({
    where: {
      organizationId: orgId,
      sprintId,
      status: opts.done ? "done" : { not: "done" },
    },
  });
}

/**
 * Last `limit` completed sprints for the cross-sprint trends (Spec 3 §5). Ordered
 * seq DESC so the take() keeps the most recent — the service reverses to ASC for
 * the chart. Reads the frozen `completedCount`/`carriedOverCount` snapshots.
 */
export async function listCompletedSprints(orgId: string, limit: number): Promise<DbSprint[]> {
  const db = getDb();
  return db.sprint.findMany({
    where: { organizationId: orgId, status: "completed" },
    orderBy: { seq: "desc" },
    take: limit,
  });
}

/**
 * Live total task count attached to a sprint (done + not-done) — the burndown
 * scope for an *active* sprint (Spec 3 §4). Org-scoped.
 */
export async function countTasksInSprint(orgId: string, sprintId: string): Promise<number> {
  const db = getDb();
  return db.task.count({ where: { organizationId: orgId, sprintId } });
}

/**
 * The `completedAt` timestamps of this sprint's done tasks (Spec 3 §4 actual line).
 * Nulls are filtered out so the service can count completions per day. Org-scoped.
 */
export async function listDoneCompletions(orgId: string, sprintId: string): Promise<Date[]> {
  const db = getDb();
  const rows = await db.task.findMany({
    where: { organizationId: orgId, sprintId, status: "done", completedAt: { not: null } },
    select: { completedAt: true },
  });
  return rows.map((r) => r.completedAt).filter((d): d is Date => d !== null);
}
