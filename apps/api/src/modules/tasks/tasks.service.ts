import type { Prisma } from "@kason/db";
import type {
  AssignTaskInput,
  CreateTaskInput,
  ListTasksQueryInput,
  MoveTaskInput,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { StaleUpdateError } from "../../lib/concurrency-error";
import { createSignedDownloadUrl, deleteObjectsBestEffort } from "../../lib/storage";
import {
  createTaskRow,
  deleteTaskRow,
  findActiveOperator,
  findListing,
  findTask,
  findTaskInTx,
  findTicketById,
  getUsersByIds,
  listTasks,
  nextLaneSortOrder,
  renumberLane,
  updateTaskGuarded,
  withTransaction,
  type DbTask,
} from "./tasks.repository";
import {
  collectTicketStorageKeys,
  deleteTicketCascade,
  findTicketInTx,
  updateTicketGuarded,
} from "./tickets.repository";
import { findSprint } from "./sprints.repository";
import {
  mirrorTicketFieldsFromTask,
  mirrorTicketFromTask,
  reopenTicketFromTask,
  spawnTicketForTask,
} from "./mirror";
import type { TaskRow, TasksActorCtx, TasksServiceResult } from "./tasks.types";

const STALE = "Record changed — reloaded";
const ARCHIVED_409 = "Task is archived — restore it first";

type AssigneeInfo = { fullName: string; photoUrl: string | null };

function mapTask(t: DbTask, assignees: Map<string, AssigneeInfo>): TaskRow {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    category: t.category,
    sortOrder: t.sortOrder,
    attachmentKeys: t.attachmentKeys,
    assignee: t.assigneeUserId
      ? {
          id: t.assigneeUserId,
          fullName: assignees.get(t.assigneeUserId)?.fullName ?? "",
          photoUrl: assignees.get(t.assigneeUserId)?.photoUrl ?? null,
        }
      : null,
    relatedUnit: t.relatedUnit
      ? {
          id: t.relatedUnit.id,
          unitCode: t.relatedUnit.apartment.unitCode,
          propertyName: t.relatedUnit.apartment.property.name,
        }
      : null,
    ticketId: t.ticketId,
    sprintId: t.sprintId,
    dueOn: t.dueOn?.toISOString() ?? null,
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    assignedAt: t.assignedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// Distinct assignees per request are few (the operators), so signing one URL
// each mirrors users.service.ts and stays cheap.
async function assigneeNamesFor(orgId: string, rows: DbTask[]): Promise<Map<string, AssigneeInfo>> {
  const ids = [
    ...new Set(rows.map((r) => r.assigneeUserId).filter((id): id is string => id !== null)),
  ];
  const users = await getUsersByIds(orgId, ids);
  const entries = await Promise.all(
    users.map(
      async (u) =>
        [
          u.id,
          { fullName: u.fullName, photoUrl: u.photoKey ? await createSignedDownloadUrl(u.photoKey) : null },
        ] as const,
    ),
  );
  return new Map(entries);
}

export async function listTasksService(
  ctx: TasksActorCtx,
  query: ListTasksQueryInput,
): Promise<TasksServiceResult<TaskRow[]>> {
  const rows = await listTasks(ctx.orgId, query);
  const names = await assigneeNamesFor(ctx.orgId, rows);
  return { ok: true as const, status: 200, data: rows.map((r) => mapTask(r, names)) };
}

export async function getTaskService(
  ctx: TasksActorCtx,
  taskId: string,
): Promise<TasksServiceResult<TaskRow>> {
  const task = await findTask(ctx.orgId, taskId);
  if (!task) return { ok: false as const, status: 404, error: "Task not found" };
  const names = await assigneeNamesFor(ctx.orgId, [task]);
  return { ok: true as const, status: 200, data: mapTask(task, names) };
}

export async function createTaskService(
  ctx: TasksActorCtx,
  input: CreateTaskInput,
): Promise<TasksServiceResult<TaskRow>> {
  if (input.assigneeUserId) {
    const operator = await findActiveOperator(ctx.orgId, input.assigneeUserId);
    if (!operator) {
      return { ok: false as const, status: 400, error: "Assignee must be an active admin user" };
    }
  }
  let relatedUnitId = input.relatedUnitId ?? null;
  if (input.relatedUnitId) {
    const unit = await findListing(ctx.orgId, input.relatedUnitId);
    if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  }
  if (input.ticketId) {
    const ticket = await findTicketById(ctx.orgId, input.ticketId);
    if (!ticket) return { ok: false as const, status: 404, error: "Ticket not found" };
    // Spawn-from-ticket inherits the ticket's unit unless the caller pinned one.
    if (!input.relatedUnitId) relatedUnitId = ticket.unitId;
  }
  if (input.sprintId) {
    const sprint = await findSprint(ctx.orgId, input.sprintId);
    if (!sprint) return { ok: false as const, status: 404, error: "Sprint not found" };
  }
  const status = input.assigneeUserId ? "todo" : "pool";

  const created = await withTransaction(async (tx) => {
    const sortOrder = await nextLaneSortOrder(tx, ctx.orgId, status);
    const row = await createTaskRow(tx, {
      organizationId: ctx.orgId,
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority,
      category: input.category ?? null,
      sortOrder,
      assigneeUserId: input.assigneeUserId ?? null,
      assignedAt: input.assigneeUserId ? new Date() : null,
      relatedUnitId,
      ticketId: input.ticketId ?? null,
      sprintId: input.sprintId ?? null,
      createdBy: ctx.actorUserId,
      dueOn: input.dueOn ? new Date(input.dueOn) : null,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "tasks.task.create",
      entityType: "Task",
      entityId: row.id,
      diff: { after: row } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // Reverse mirror: a unit-linked task that wasn't spawned FROM a ticket gets its own ticket.
    if (relatedUnitId && !input.ticketId) {
      const ticketId = await spawnTicketForTask(tx, ctx, {
        id: row.id,
        relatedUnitId,
        title: row.title,
        description: row.description,
        category: row.category,
      });
      await tx.task.updateMany({ where: { id: row.id, organizationId: ctx.orgId }, data: { ticketId } });
      // updateMany bumped @updatedAt in the DB — refresh the returned row so the
      // client's next optimistic-concurrency write doesn't get a spurious 409.
      const fresh = await tx.task.findFirst({
        where: { id: row.id, organizationId: ctx.orgId },
        select: { updatedAt: true },
      });
      row.ticketId = ticketId;
      if (fresh) row.updatedAt = fresh.updatedAt;
    }
    return row;
  });

  const names = await assigneeNamesFor(ctx.orgId, [created]);
  return { ok: true as const, status: 201, data: mapTask(created, names) };
}

export async function updateTaskService(
  ctx: TasksActorCtx,
  input: UpdateTaskInput,
): Promise<TasksServiceResult<TaskRow>> {
  const existing = await findTask(ctx.orgId, input.taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };
  if (existing.status === "archived") {
    return { ok: false as const, status: 409, error: ARCHIVED_409 };
  }
  if (input.relatedUnitId !== undefined && input.relatedUnitId !== null) {
    const unit = await findListing(ctx.orgId, input.relatedUnitId);
    if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  }
  if (input.sprintId !== undefined && input.sprintId !== null) {
    const sprint = await findSprint(ctx.orgId, input.sprintId);
    if (!sprint) return { ok: false as const, status: 404, error: "Sprint not found" };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateTaskGuarded(tx, ctx.orgId, input.taskId, input.updatedAt, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.relatedUnitId !== undefined ? { relatedUnitId: input.relatedUnitId } : {}),
        ...(input.dueOn !== undefined
          ? { dueOn: input.dueOn ? new Date(input.dueOn) : null }
          : {}),
        ...(input.sprintId !== undefined ? { sprintId: input.sprintId } : {}),
      });
      // First time a ticketless task gains a unit → spawn its paired ticket.
      const newUnitId = input.relatedUnitId;
      if (newUnitId != null && !existing.ticketId && !row.ticketId) {
        const ticketId = await spawnTicketForTask(tx, ctx, {
          id: row.id,
          relatedUnitId: newUnitId,
          title: row.title,
          description: row.description,
          category: row.category,
        });
        await tx.task.updateMany({ where: { id: row.id, organizationId: ctx.orgId }, data: { ticketId } });
        // updateMany bumped @updatedAt in the DB — refresh the returned row so the
        // client's next optimistic-concurrency write doesn't get a spurious 409.
        const fresh = await tx.task.findFirst({
          where: { id: row.id, organizationId: ctx.orgId },
          select: { updatedAt: true },
        });
        row.ticketId = ticketId;
        if (fresh) row.updatedAt = fresh.updatedAt;
      }
      // Shared-field edits mirror onto the open paired ticket. Only for a
      // pre-existing link — a ticket spawned above already carries the final
      // values.
      if (existing.ticketId) {
        await mirrorTicketFieldsFromTask(tx, ctx, existing.ticketId, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
        });
      }
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.update",
        entityType: "Task",
        entityId: row.id,
        diff: { before: existing, after: row } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    const names = await assigneeNamesFor(ctx.orgId, [updated]);
    return { ok: true as const, status: 200, data: mapTask(updated, names) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function moveTaskService(
  ctx: TasksActorCtx,
  input: MoveTaskInput,
): Promise<TasksServiceResult<TaskRow>> {
  const existing = await findTask(ctx.orgId, input.taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };
  if (existing.status === "archived") {
    return { ok: false as const, status: 409, error: ARCHIVED_409 };
  }

  try {
    const moved = await withTransaction(async (tx) => {
      const data: Prisma.TaskUncheckedUpdateManyInput = { status: input.status };
      if (input.status === "pool") {
        data.assigneeUserId = null;
        data.assignedAt = null;
      }
      if (input.status === "in_progress" && !existing.startedAt) data.startedAt = new Date();
      // Only stamp completedAt on entry into done — a within-done-lane reorder
      // must not rewrite the original completion timestamp.
      if (input.status === "done" && existing.status !== "done") data.completedAt = new Date();
      if (existing.status === "done" && input.status !== "done") data.completedAt = null;
      if (input.position === undefined) {
        data.sortOrder = await nextLaneSortOrder(tx, ctx.orgId, input.status);
      }
      let updated = await updateTaskGuarded(tx, ctx.orgId, input.taskId, input.updatedAt, data);
      if (input.position !== undefined) {
        await renumberLane(tx, ctx.orgId, input.status, input.taskId, input.position);
        // renumberLane rewrote this task's sortOrder — re-read in-tx so the
        // audit `after` and the returned row both carry the final value.
        const fresh = await findTaskInTx(tx, ctx.orgId, input.taskId);
        if (!fresh) throw new StaleUpdateError();
        updated = fresh;
      }
      // Mirror the ticket: a pull-back out of done reopens it; moves into
      // done/in_progress resolve it / mark work started.
      if (existing.ticketId) {
        const ticket = await tx.ticket.findFirst({
          where: { id: existing.ticketId, organizationId: ctx.orgId },
          select: { id: true, unitId: true, status: true },
        });
        if (ticket) {
          if (existing.status === "done" && input.status !== "done") {
            await reopenTicketFromTask(tx, ctx, ticket, input.status);
          } else if (input.status === "done" || input.status === "in_progress") {
            await mirrorTicketFromTask(tx, ctx, ticket, input.status === "done" ? "resolved" : "in_progress");
          }
        }
      }
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.move",
        entityType: "Task",
        entityId: input.taskId,
        diff: {
          before: { status: existing.status, sortOrder: existing.sortOrder },
          after: {
            status: input.status,
            sortOrder: updated.sortOrder,
            position: input.position ?? null,
          },
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
    const names = await assigneeNamesFor(ctx.orgId, [moved]);
    return { ok: true as const, status: 200, data: mapTask(moved, names) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function assignTaskService(
  ctx: TasksActorCtx,
  input: AssignTaskInput,
): Promise<TasksServiceResult<TaskRow>> {
  const existing = await findTask(ctx.orgId, input.taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };
  if (existing.status === "archived") {
    return { ok: false as const, status: 409, error: ARCHIVED_409 };
  }
  if (input.assigneeUserId === null && existing.status === "done") {
    return {
      ok: false as const,
      status: 409,
      error: "Completed tasks keep their assignee — move it out of done first",
    };
  }
  if (input.assigneeUserId) {
    const operator = await findActiveOperator(ctx.orgId, input.assigneeUserId);
    if (!operator) {
      return { ok: false as const, status: 400, error: "Assignee must be an active admin user" };
    }
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const data: Prisma.TaskUncheckedUpdateManyInput = {
        assigneeUserId: input.assigneeUserId,
        assignedAt: input.assigneeUserId ? new Date() : null,
      };
      if (input.assigneeUserId && existing.status === "pool") {
        data.status = "todo";
        data.sortOrder = await nextLaneSortOrder(tx, ctx.orgId, "todo");
      }
      if (input.assigneeUserId === null && existing.status !== "pool") {
        data.status = "pool";
        data.sortOrder = await nextLaneSortOrder(tx, ctx.orgId, "pool");
      }
      const row = await updateTaskGuarded(tx, ctx.orgId, input.taskId, input.updatedAt, data);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.assign",
        entityType: "Task",
        entityId: row.id,
        meta: { from: existing.assigneeUserId, to: input.assigneeUserId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    const names = await assigneeNamesFor(ctx.orgId, [updated]);
    return { ok: true as const, status: 200, data: mapTask(updated, names) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function archiveTaskService(
  ctx: TasksActorCtx,
  input: { taskId: string; updatedAt: string },
): Promise<TasksServiceResult<TaskRow>> {
  const existing = await findTask(ctx.orgId, input.taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };
  if (existing.status === "archived") {
    return { ok: false as const, status: 409, error: "Task is already archived" };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateTaskGuarded(tx, ctx.orgId, input.taskId, input.updatedAt, {
        status: "archived",
      });
      // Mirror the linked ticket to void.
      if (existing.ticketId) {
        const ticket = await tx.ticket.findFirst({
          where: { id: existing.ticketId, organizationId: ctx.orgId },
          select: { id: true, unitId: true, status: true },
        });
        if (ticket) await mirrorTicketFromTask(tx, ctx, ticket, "void");
      }
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.archive",
        entityType: "Task",
        entityId: row.id,
        meta: { fromStatus: existing.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    const names = await assigneeNamesFor(ctx.orgId, [updated]);
    return { ok: true as const, status: 200, data: mapTask(updated, names) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function restoreTaskService(
  ctx: TasksActorCtx,
  input: { taskId: string; updatedAt: string },
): Promise<TasksServiceResult<TaskRow>> {
  const existing = await findTask(ctx.orgId, input.taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };
  if (existing.status !== "archived") {
    return { ok: false as const, status: 409, error: "Task is not archived" };
  }
  const target = existing.assigneeUserId ? "todo" : "pool";

  try {
    const updated = await withTransaction(async (tx) => {
      const sortOrder = await nextLaneSortOrder(tx, ctx.orgId, target);
      const row = await updateTaskGuarded(tx, ctx.orgId, input.taskId, input.updatedAt, {
        status: target,
        sortOrder,
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.task.restore",
        entityType: "Task",
        entityId: row.id,
        meta: { toStatus: target },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // Symmetric with archiveTaskService (which voided the linked ticket):
      // reopen it. Only when it is still void — an independently-reopened ticket
      // is left alone. Same transaction ⇒ task + ticket restore atomically.
      if (existing.ticketId) {
        const ticket = await findTicketInTx(tx, ctx.orgId, existing.ticketId);
        if (ticket && ticket.status === "void") {
          await updateTicketGuarded(tx, ctx.orgId, ticket.id, ticket.updatedAt.toISOString(), {
            status: "open",
            resolvedAt: null,
          });
          await recordAudit(tx, {
            organizationId: ctx.orgId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            action: "tasks.ticket.reopen",
            entityType: "Ticket",
            entityId: ticket.id,
            meta: { from: "void", to: "open", via: "task.restore" },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
      }
      return row;
    });
    const names = await assigneeNamesFor(ctx.orgId, [updated]);
    return { ok: true as const, status: 200, data: mapTask(updated, names) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

/**
 * Hard-delete a task and (if linked) its paired ticket + ticket history.
 * Collects storage keys before the transaction, deletes history then ticket
 * then task inside the transaction, and cleans up storage after commit.
 */
export async function deleteTaskService(
  ctx: TasksActorCtx,
  taskId: string,
): Promise<TasksServiceResult<{ id: string }>> {
  const existing = await findTask(ctx.orgId, taskId);
  if (!existing) return { ok: false as const, status: 404, error: "Task not found" };

  // Collect all storage keys BEFORE the transaction — rows won't exist after.
  const storageKeys: string[] = [...existing.attachmentKeys];
  if (existing.ticketId) {
    storageKeys.push(...(await collectTicketStorageKeys(ctx.orgId, existing.ticketId)));
  }

  await withTransaction(async (tx) => {
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "tasks.task.delete",
      entityType: "Task",
      entityId: existing.id,
      meta: { title: existing.title, status: existing.status, ticketId: existing.ticketId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (existing.ticketId) {
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.delete",
        entityType: "Ticket",
        entityId: existing.ticketId,
        meta: { viaTask: taskId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await deleteTicketCascade(tx, ctx.orgId, existing.ticketId);
    }
    await deleteTaskRow(tx, ctx.orgId, taskId);
  });

  // Best-effort storage cleanup AFTER commit — storage isn't transactional.
  // A failed delete is logged internally by deleteObjectsBestEffort, not fatal.
  await deleteObjectsBestEffort(storageKeys);

  return { ok: true as const, status: 200, data: { id: taskId } };
}
