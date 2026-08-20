import { Prisma } from "@kason/db";
import type {
  CreateSprintInput,
  ListSprintsQueryInput,
  SprintLifecycleInput,
  SprintStatus,
  UpdateSprintInput,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { StaleUpdateError } from "../../lib/concurrency-error";
import {
  countSprintTasks,
  countTasksInSprint,
  createSprintRow,
  findSprint,
  findSprintInTx,
  listCompletedSprints,
  listDoneCompletions,
  listSprints,
  nextSprintSeq,
  updateSprintGuarded,
  withTransaction,
  type DbSprint,
} from "./sprints.repository";
import type {
  BurndownPoint,
  SprintBurndown,
  SprintRow,
  SprintSummary,
  SprintTrendPoint,
} from "./sprints.types";
import type { TasksActorCtx, TasksServiceResult } from "./tasks.types";

const STALE = "Record changed — reloaded";
const NOT_FOUND = "Sprint not found";
const NOT_PLANNED = "Only a planned sprint can be started";
const NOT_ACTIVE = "Only an active sprint can be closed";
export const COMPLETED_NOT_DELETABLE = "Completed sprints can't be deleted";

const SPRINT_LENGTH_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRENDS_WINDOW = 8;

/**
 * Summary counts for a sprint (§1.10).
 * - planned/active (live): completed/carried counted from attached tasks.
 * - completed (snapshot): read the frozen `completedCount`/`carriedOverCount` columns.
 * `tx` is forwarded to `countSprintTasks` so the close ceremony reads inside its tx;
 * read paths pass no tx (→ getDb()).
 */
export async function buildSprintSummary(
  orgId: string,
  s: DbSprint,
  tx?: Prisma.TransactionClient,
): Promise<SprintSummary> {
  let completed: number;
  let carried: number;
  if (s.status === "completed") {
    completed = s.completedCount ?? 0;
    carried = s.carriedOverCount ?? 0;
  } else {
    completed = await countSprintTasks(orgId, s.id, { done: true }, tx);
    carried = await countSprintTasks(orgId, s.id, { done: false }, tx);
  }
  const committed = completed + carried;
  const completionPct = committed === 0 ? 0 : Math.round((completed / committed) * 100);
  return { committed, completed, carried, completionPct };
}

function mapSprint(s: DbSprint, summary: SprintSummary): SprintRow {
  return {
    id: s.id,
    seq: s.seq,
    name: s.name,
    goal: s.goal,
    status: s.status as SprintStatus,
    startsOn: s.startsOn?.toISOString() ?? null,
    endsOn: s.endsOn?.toISOString() ?? null,
    startedAt: s.startedAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    summary,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function rowFor(orgId: string, s: DbSprint): Promise<SprintRow> {
  return mapSprint(s, await buildSprintSummary(orgId, s));
}

export async function listSprintsService(
  ctx: TasksActorCtx,
  query: ListSprintsQueryInput,
): Promise<TasksServiceResult<SprintRow[]>> {
  const rows = await listSprints(ctx.orgId, query);
  const data = await Promise.all(rows.map((s) => rowFor(ctx.orgId, s)));
  return { ok: true as const, status: 200, data };
}

export async function getSprintService(
  ctx: TasksActorCtx,
  sprintId: string,
): Promise<TasksServiceResult<SprintRow>> {
  const sprint = await findSprint(ctx.orgId, sprintId);
  if (!sprint) return { ok: false as const, status: 404, error: NOT_FOUND };
  return { ok: true as const, status: 200, data: await rowFor(ctx.orgId, sprint) };
}

export async function createSprintService(
  ctx: TasksActorCtx,
  input: CreateSprintInput,
): Promise<TasksServiceResult<SprintRow>> {
  const startsOn = input.startsOn ? new Date(input.startsOn) : null;
  const endsOn = input.endsOn
    ? new Date(input.endsOn)
    : startsOn
      ? new Date(startsOn.getTime() + SPRINT_LENGTH_MS)
      : null;

  try {
    const created = await withTransaction(async (tx) => {
      const seq = await nextSprintSeq(tx, ctx.orgId);
      const row = await createSprintRow(tx, {
        organizationId: ctx.orgId,
        seq,
        name: input.name ?? null,
        goal: input.goal ?? null,
        status: "planned",
        startsOn,
        endsOn,
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.sprint.create",
        entityType: "Sprint",
        entityId: row.id,
        diff: { after: row } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 201, data: await rowFor(ctx.orgId, created) };
  } catch (err) {
    // A concurrent create can collide on @@unique([organizationId, seq]) — surface
    // as stale so the client re-reads + retries (§1.9).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function updateSprintService(
  ctx: TasksActorCtx,
  input: UpdateSprintInput,
): Promise<TasksServiceResult<SprintRow>> {
  const existing = await findSprint(ctx.orgId, input.sprintId);
  if (!existing) return { ok: false as const, status: 404, error: NOT_FOUND };

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateSprintGuarded(tx, ctx.orgId, input.sprintId, input.updatedAt, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.startsOn !== undefined
          ? { startsOn: input.startsOn ? new Date(input.startsOn) : null }
          : {}),
        ...(input.endsOn !== undefined
          ? { endsOn: input.endsOn ? new Date(input.endsOn) : null }
          : {}),
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.sprint.update",
        entityType: "Sprint",
        entityId: row.id,
        diff: { before: existing, after: row } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 200, data: await rowFor(ctx.orgId, updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function startSprintService(
  ctx: TasksActorCtx,
  input: SprintLifecycleInput,
): Promise<TasksServiceResult<SprintRow>> {
  try {
    const result = await withTransaction(async (tx) => {
      const s = await findSprintInTx(tx, ctx.orgId, input.sprintId);
      if (!s) return { ok: false as const, status: 404, error: NOT_FOUND } as const;
      if (s.status !== "planned") {
        return { ok: false as const, status: 400, error: NOT_PLANNED } as const;
      }
      // Multiple sprints may be active at once (name-only model, 2026-06-22). No
      // single-active guard: tasks are scoped per sprint and admins switch via the
      // Sprint picker. Spec: docs/superpowers/specs/2026-06-22-tasks-board-ux-design.md
      const n = await tx.sprint.updateMany({
        where: { id: input.sprintId, organizationId: ctx.orgId, updatedAt: new Date(input.updatedAt) },
        data: { status: "active", startedAt: new Date(), startsOn: s.startsOn ?? new Date() },
      });
      if (n.count === 0) throw new StaleUpdateError();
      const row = await findSprintInTx(tx, ctx.orgId, input.sprintId);
      if (!row) throw new StaleUpdateError();
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.sprint.start",
        entityType: "Sprint",
        entityId: row.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true as const, row } as const;
    });
    if (!result.ok) return result;
    return { ok: true as const, status: 200, data: await rowFor(ctx.orgId, result.row) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function closeSprintService(
  ctx: TasksActorCtx,
  input: SprintLifecycleInput,
): Promise<TasksServiceResult<SprintRow>> {
  try {
    const result = await withTransaction(async (tx) => {
      const s = await findSprintInTx(tx, ctx.orgId, input.sprintId);
      if (!s) return { ok: false as const, status: 404, error: NOT_FOUND } as const;
      if (s.status !== "active") {
        return { ok: false as const, status: 400, error: NOT_ACTIVE } as const;
      }
      const carried = await countSprintTasks(ctx.orgId, input.sprintId, { done: false }, tx);
      const completed = await countSprintTasks(ctx.orgId, input.sprintId, { done: true }, tx);
      // Carry incomplete tasks back to Backlog (sprintId null); done tasks keep
      // sprintId = the closed sprint (frozen report).
      await tx.task.updateMany({
        where: { organizationId: ctx.orgId, sprintId: input.sprintId, status: { not: "done" } },
        data: { sprintId: null },
      });
      const n = await tx.sprint.updateMany({
        where: { id: input.sprintId, organizationId: ctx.orgId, updatedAt: new Date(input.updatedAt) },
        data: {
          status: "completed",
          completedAt: new Date(),
          completedCount: completed,
          carriedOverCount: carried,
        },
      });
      if (n.count === 0) throw new StaleUpdateError();
      const row = await findSprintInTx(tx, ctx.orgId, input.sprintId);
      if (!row) throw new StaleUpdateError();
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.sprint.close",
        entityType: "Sprint",
        entityId: row.id,
        meta: { completedCount: completed, carriedOverCount: carried },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true as const, row } as const;
    });
    if (!result.ok) return result;
    return { ok: true as const, status: 200, data: await rowFor(ctx.orgId, result.row) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function deleteSprintService(
  ctx: TasksActorCtx,
  input: SprintLifecycleInput,
): Promise<TasksServiceResult<{ id: string }>> {
  try {
    const result = await withTransaction(async (tx) => {
      const s = await findSprintInTx(tx, ctx.orgId, input.sprintId);
      if (!s) return { ok: false as const, status: 404, error: NOT_FOUND } as const;
      if (s.status === "completed") {
        return { ok: false as const, status: 400, error: COMPLETED_NOT_DELETABLE } as const;
      }
      // Race-safe guard: lock the sprint row so a concurrent task-assignment
      // (which takes FOR KEY SHARE on this row via its FK) cannot commit between
      // our count and our delete — otherwise onDelete:SetNull could silently move
      // a just-assigned task to the Backlog. With the lock, the assignment either
      // waits and then fails cleanly (sprint gone) or commits first and is seen
      // by the count below → 409. Assigning a task doesn't bump the sprint's
      // updatedAt, so the count — not the timestamp — is the authoritative guard;
      // the lock is what makes the count-then-delete pair atomic against it.
      await tx.$queryRaw`SELECT id FROM "Sprint" WHERE id = ${input.sprintId}::uuid AND "organizationId" = ${ctx.orgId}::uuid FOR UPDATE`;
      const taskCount = await tx.task.count({
        where: { organizationId: ctx.orgId, sprintId: input.sprintId },
      });
      if (taskCount > 0) {
        const noun = taskCount === 1 ? "task" : "tasks";
        const them = taskCount === 1 ? "it" : "them";
        return {
          ok: false as const,
          status: 409,
          error: `This sprint still has ${taskCount} ${noun} assigned. Move ${them} to another sprint or the Backlog first.`,
        } as const;
      }
      const n = await tx.sprint.deleteMany({
        where: {
          id: input.sprintId,
          organizationId: ctx.orgId,
          updatedAt: new Date(input.updatedAt),
        },
      });
      if (n.count === 0) throw new StaleUpdateError();
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.sprint.delete",
        entityType: "Sprint",
        entityId: input.sprintId,
        diff: { before: s } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true as const, id: input.sprintId } as const;
    });
    if (!result.ok) return result;
    return { ok: true as const, status: 200, data: { id: result.id } };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

// ─── Spec 3: cross-sprint trends + within-sprint burndown (read-only, derived) ──

function completionRate(completed: number, carried: number): number {
  const committed = completed + carried;
  return committed === 0 ? 0 : Math.round((completed / committed) * 100);
}

/**
 * Cross-sprint trends (Spec 3 §5/§7): the last `window` completed sprints, read
 * from the close-snapshot columns, ordered by seq ASC for the chart. Pure read,
 * no audit. `completionRate` handles a zero-committed sprint without dividing by
 * zero (§8).
 */
export async function trendsService(
  ctx: TasksActorCtx,
  query: { window?: number },
): Promise<TasksServiceResult<SprintTrendPoint[]>> {
  const window = query.window ?? DEFAULT_TRENDS_WINDOW;
  const rows = await listCompletedSprints(ctx.orgId, window);
  // repo gives seq DESC (most-recent N); reverse to seq ASC for the output series.
  const data: SprintTrendPoint[] = [...rows].reverse().map((s) => {
    const completed = s.completedCount ?? 0;
    const carried = s.carriedOverCount ?? 0;
    return {
      seq: s.seq,
      name: s.name,
      completed,
      carried,
      completionRate: completionRate(completed, carried),
    };
  });
  return { ok: true as const, status: 200, data };
}

/** Normalise a Date to its UTC calendar day (midnight Z). */
function toUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** ISO `YYYY-MM-DD` for a UTC-day Date. */
function dayLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pure burndown derivation (Spec 3 §4). Injectable `now` makes the active "stop
 * at today" branch deterministically testable. Days are UTC calendar days; a
 * task counts as done on day `d` when `completedAt < d+1 00:00Z` (end-of-day d).
 *
 * - scope: caller supplies (live count for active; completedCount+carriedOverCount
 *   for completed).
 * - ideal: linear `scope → 0` across the window, one point per UTC day. A single-
 *   day window (startsOn === endsOn) yields one point at `scope` (no separate end
 *   sample to interpolate to 0).
 * - actual: remaining(d) = scope − (done tasks with completedAt ≤ end-of-day d).
 *   active → only up to `now`'s day (no projection); completed → full window, so
 *   the line terminates at `scope − total-done` (= carriedOverCount when all done
 *   completions fall in-window) rather than being forced to 0.
 * - degenerate: when startsOn/endsOn is null the sprint was never dated → empty
 *   ideal/actual with the bare scope (safe, documented §4).
 */
export function buildBurndown(args: {
  scope: number;
  startsOn: Date | null;
  endsOn: Date | null;
  status: SprintStatus;
  completions: Date[];
  now?: Date;
}): SprintBurndown {
  const { scope, startsOn, endsOn, status, completions } = args;
  const now = args.now ?? new Date();

  if (!startsOn || !endsOn) {
    return { scope, ideal: [], actual: [] };
  }

  const startDay = toUtcDay(startsOn);
  const endDay = toUtcDay(endsOn);
  const totalDays = Math.max(0, Math.round((endDay.getTime() - startDay.getTime()) / DAY_MS)) + 1;
  const lastIndex = totalDays - 1;

  // ideal: linear scope → 0 across [startDay, endDay]; single-day window → [scope].
  const ideal: BurndownPoint[] = [];
  for (let i = 0; i < totalDays; i++) {
    const date = dayLabel(new Date(startDay.getTime() + i * DAY_MS));
    const remaining = lastIndex === 0 ? scope : Math.round((scope * (lastIndex - i)) / lastIndex);
    ideal.push({ date, remaining });
  }

  // actual: active stops at today; completed plots the full window.
  const todayDay = toUtcDay(now);
  const actualEndDay =
    status === "completed" ? endDay : new Date(Math.min(endDay.getTime(), todayDay.getTime()));
  const actual: BurndownPoint[] = [];
  if (actualEndDay.getTime() >= startDay.getTime()) {
    const actualDays = Math.round((actualEndDay.getTime() - startDay.getTime()) / DAY_MS) + 1;
    for (let i = 0; i < actualDays; i++) {
      const day = new Date(startDay.getTime() + i * DAY_MS);
      const endOfDay = day.getTime() + DAY_MS; // exclusive: completedAt < next-day-00:00Z
      const doneByDay = completions.reduce((n, c) => (c.getTime() < endOfDay ? n + 1 : n), 0);
      actual.push({ date: dayLabel(day), remaining: scope - doneByDay });
    }
  }

  return { scope, ideal, actual };
}

/**
 * Within-sprint burndown for one sprint (Spec 3 §4/§7). Resolves scope from the
 * live task count (active) or the close snapshot (completed), pulls done-task
 * completion timestamps, then defers to the pure `buildBurndown`. Read-only.
 */
export async function burndownService(
  ctx: TasksActorCtx,
  sprintId: string,
  now?: Date,
): Promise<TasksServiceResult<SprintBurndown>> {
  const sprint = await findSprint(ctx.orgId, sprintId);
  if (!sprint) return { ok: false as const, status: 404, error: NOT_FOUND };

  const scope =
    sprint.status === "completed"
      ? (sprint.completedCount ?? 0) + (sprint.carriedOverCount ?? 0)
      : await countTasksInSprint(ctx.orgId, sprintId);
  const completions = await listDoneCompletions(ctx.orgId, sprintId);

  const data = buildBurndown({
    scope,
    startsOn: sprint.startsOn,
    endsOn: sprint.endsOn,
    status: sprint.status as SprintStatus,
    completions,
    now,
  });
  return { ok: true as const, status: 200, data };
}
