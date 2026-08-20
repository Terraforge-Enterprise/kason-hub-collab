/**
 * In-transaction mirror helpers for the Ticket ⇄ Task 1:1 auto-mirror.
 *
 * Architecture invariant: every helper takes an open Prisma.TransactionClient
 * `tx` and writes the counterpart row via `tx` directly — NEVER by calling a
 * service (createTicketService, moveTaskService, etc.). This is the recursion
 * guard: the service layer calls these helpers inside its own transaction; the
 * helpers write the counterpart without re-entering any service, so there is
 * no mirror→service→mirror loop.
 *
 * All mutations are also audited inside the same `tx` via `recordAudit`.
 */
import type { Prisma } from "@kason/db";
import type { TaskPriority } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import {
  createTaskRow,
  findClosedTaskByTicketId,
  findOpenTaskByTicketId,
  nextLaneSortOrder,
} from "./tasks.repository";
import { createHistoryRow, createTicketRow } from "./tickets.repository";
import type { TasksActorCtx } from "./tasks.types";

type MinTicket = {
  id: string;
  unitId: string;
  title: string;
  description: string | null;
  category: string | null;
};

type MinTask = {
  id: string;
  relatedUnitId: string;
  title: string;
  description: string | null;
  category: string | null;
};

/** New-ticket form seeds carried by the spawned Task only (no Ticket columns). */
export type TaskSpawnSeed = {
  priority: TaskPriority;
  assigneeUserId: string | null;
  dueOn: Date | null;
};

/**
 * Ticket created → spawn its paired board Task (inherits shared fields; seed
 * sets priority/assignee/dueOn). Assigned tasks land in todo with assignedAt
 * stamped — same lane rule as createTaskService. Caller validates the assignee.
 * Called from inside the createTicketService transaction.
 */
export async function spawnTaskForTicket(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticket: MinTicket,
  seed?: TaskSpawnSeed,
): Promise<void> {
  const status = seed?.assigneeUserId ? "todo" : "pool";
  const sortOrder = await nextLaneSortOrder(tx, ctx.orgId, status);
  const row = await createTaskRow(tx, {
    organizationId: ctx.orgId,
    title: ticket.title,
    description: ticket.description,
    status,
    priority: seed?.priority ?? "medium",
    category: ticket.category,
    sortOrder,
    assigneeUserId: seed?.assigneeUserId ?? null,
    assignedAt: seed?.assigneeUserId ? new Date() : null,
    relatedUnitId: ticket.unitId,
    ticketId: ticket.id,
    sprintId: null,
    createdBy: ctx.actorUserId,
    dueOn: seed?.dueOn ?? null,
  });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.task.spawn_from_ticket",
    entityType: "Task",
    entityId: row.id,
    meta: { ticketId: ticket.id },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Board Task linked to a unit → spawn its paired Ticket (open, warrantyFlag false).
 * Called from inside the createTaskService / updateTaskService transaction.
 * Returns the new ticket's id so the caller can link `Task.ticketId`.
 */
export async function spawnTicketForTask(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  task: MinTask,
): Promise<string> {
  const row = await createTicketRow(tx, {
    organizationId: ctx.orgId,
    unitId: task.relatedUnitId,
    title: task.title,
    description: task.description,
    category: task.category,
    status: "open",
    warrantyFlag: false,
    createdBy: ctx.actorUserId,
  });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.ticket.spawn_from_task",
    entityType: "Ticket",
    entityId: row.id,
    meta: { taskId: task.id },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return row.id;
}

/**
 * Ticket resolved/voided → mirror onto its single open linked task.
 * No-op if no open task is linked (task was already closed, or never existed).
 * Called from inside the resolveTicketService / voidTicketService transaction.
 */
export async function mirrorTaskFromTicket(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticketId: string,
  target: "done" | "archived",
): Promise<void> {
  const task = await findOpenTaskByTicketId(tx, ctx.orgId, ticketId);
  if (!task) return;
  const data: Prisma.TaskUncheckedUpdateManyInput = { status: target };
  if (target === "done") data.completedAt = new Date();
  await tx.task.updateMany({ where: { id: task.id, organizationId: ctx.orgId }, data });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.task.mirror",
    entityType: "Task",
    entityId: task.id,
    meta: { ticketId, target },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Task pulled back out of done → reopen its resolved ticket (work resumed).
 * The lane names the ticket status: in_progress stays hands-on, pool/todo go
 * back to open. Void tickets are NOT touched — void means raised-in-error, and
 * only the drawer's manager Reopen (or task restore) revives those. Writes a
 * TicketHistory note, symmetric with resolve's "Done on board.".
 */
export async function reopenTicketFromTask(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticket: { id: string; unitId: string; status: string },
  lane: "pool" | "todo" | "in_progress",
): Promise<void> {
  if (ticket.status !== "resolved") return;
  const target = lane === "in_progress" ? "in_progress" : "open";
  await tx.ticket.updateMany({
    where: { id: ticket.id, organizationId: ctx.orgId },
    data: { status: target, resolvedAt: null },
  });
  await createHistoryRow(tx, {
    organizationId: ctx.orgId,
    ticketId: ticket.id,
    unitId: ticket.unitId,
    entry: "Reopened on board.",
    attachmentKeys: [],
    actorUserId: ctx.actorUserId,
    occurredOn: new Date(),
  });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.ticket.mirror",
    entityType: "Ticket",
    entityId: ticket.id,
    meta: { target, via: "task.pullback" },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Ticket reopened in the drawer → pull its closed paired task back onto the
 * board. resolved-reopen revives the done task into in_progress (mirrors the
 * ticket's in_progress); void-reopen revives the archived task into todo/pool
 * (same lanes as task restore). No-op when an open task already exists (the
 * board is live) or no closed task is linked.
 */
export async function reopenTaskFromTicket(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticketId: string,
  from: "resolved" | "void",
): Promise<void> {
  const open = await findOpenTaskByTicketId(tx, ctx.orgId, ticketId);
  if (open) return;
  const task = await findClosedTaskByTicketId(
    tx,
    ctx.orgId,
    ticketId,
    from === "resolved" ? "done" : "archived",
  );
  if (!task) return;
  const target =
    from === "resolved" ? "in_progress" : task.assigneeUserId ? "todo" : "pool";
  const data: Prisma.TaskUncheckedUpdateManyInput = {
    status: target,
    sortOrder: await nextLaneSortOrder(tx, ctx.orgId, target),
    completedAt: null,
  };
  if (target === "in_progress" && !task.startedAt) data.startedAt = new Date();
  await tx.task.updateMany({ where: { id: task.id, organizationId: ctx.orgId }, data });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.task.mirror",
    entityType: "Task",
    entityId: task.id,
    meta: { ticketId, target, via: "ticket.reopen" },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/** Shared fields both sides of the mirror carry; each side keeps its private ones. */
type SharedFieldPatch = {
  title?: string;
  description?: string | null;
  category?: string | null;
};

/**
 * Ticket field edit → same fields on its open paired task (last writer wins).
 * No-op when nothing shared changed or no open task is linked.
 */
export async function mirrorTaskFieldsFromTicket(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticketId: string,
  fields: SharedFieldPatch,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const task = await findOpenTaskByTicketId(tx, ctx.orgId, ticketId);
  if (!task) return;
  await tx.task.updateMany({
    where: { id: task.id, organizationId: ctx.orgId },
    data: fields,
  });
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.task.mirror",
    entityType: "Task",
    entityId: task.id,
    meta: { ticketId, fields: Object.keys(fields) },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Task field edit → same fields on its open/in_progress ticket (last writer
 * wins). Terminal tickets are immutable history — the edit stays task-side.
 */
export async function mirrorTicketFieldsFromTask(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticketId: string,
  fields: SharedFieldPatch,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const result = await tx.ticket.updateMany({
    where: {
      id: ticketId,
      organizationId: ctx.orgId,
      status: { in: ["open", "in_progress"] },
    },
    data: fields,
  });
  if (result.count === 0) return;
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.ticket.mirror",
    entityType: "Ticket",
    entityId: ticketId,
    meta: { fields: Object.keys(fields) },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Task transition (done/void/in_progress) → mirror onto its linked ticket.
 * `resolved` also writes an auto TicketHistory note ("Done on board.").
 * No-op if ticket is already terminal (occurrence model: tickets never reopen).
 * Called from inside the moveTaskService / archiveTaskService transaction.
 */
export async function mirrorTicketFromTask(
  tx: Prisma.TransactionClient,
  ctx: TasksActorCtx,
  ticket: { id: string; unitId: string; status: string },
  target: "resolved" | "void" | "in_progress",
): Promise<void> {
  // Ticket already terminal → nothing to mirror (occurrence model: never reopen).
  if (ticket.status === "resolved" || ticket.status === "void") return;
  // in_progress only mirrors from open (not if already in_progress).
  if (target === "in_progress" && ticket.status !== "open") return;
  const data: Prisma.TicketUncheckedUpdateManyInput = { status: target };
  if (target === "resolved") data.resolvedAt = new Date();
  await tx.ticket.updateMany({ where: { id: ticket.id, organizationId: ctx.orgId }, data });
  if (target === "resolved") {
    await createHistoryRow(tx, {
      organizationId: ctx.orgId,
      ticketId: ticket.id,
      unitId: ticket.unitId,
      entry: "Done on board.",
      attachmentKeys: [],
      actorUserId: ctx.actorUserId,
      occurredOn: new Date(),
    });
  }
  await recordAudit(tx, {
    organizationId: ctx.orgId,
    actorUserId: ctx.actorUserId,
    actorRole: ctx.actorRole,
    action: "tasks.ticket.mirror",
    entityType: "Ticket",
    entityId: ticket.id,
    meta: { target },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
