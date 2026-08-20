import type { Prisma } from "@kason/db";
import type {
  CreateTicketInput,
  ListTicketsQueryInput,
  QuickLogInput,
  ResolveTicketInput,
  TicketStatus,
  UpdateTicketInput,
} from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { StaleUpdateError } from "../../lib/concurrency-error";
import {
  mirrorTaskFieldsFromTicket,
  mirrorTaskFromTicket,
  reopenTaskFromTicket,
  spawnTaskForTicket,
} from "./mirror";
import { findActiveOperator, findListing, getUsersByIds, withTransaction } from "./tasks.repository";
import { validateHistoryKeys } from "./tasks-media.service";
import {
  createHistoryRow,
  createTicketRow,
  findTicket,
  findTicketInTx,
  listUnitHistory,
  listUnitTickets,
  updateTicketGuarded,
  type DbHistory,
  type DbTicket,
} from "./tickets.repository";
import type { HistoryRow, TasksActorCtx, TasksServiceResult, TicketRow } from "./tasks.types";

const STALE = "Record changed — reloaded";
const CLOSED_409 = "Ticket is closed — reopen it first";
const TICKET_OPEN = new Set(["open", "in_progress"]);

function mapTicketRow(t: DbTicket): TicketRow {
  return {
    id: t.id,
    unitId: t.unitId,
    title: t.title,
    description: t.description,
    category: t.category,
    status: t.status as TicketStatus,
    warrantyFlag: t.warrantyFlag,
    attachmentKeys: t.attachmentKeys,
    historyCount: t._count.history,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function mapHistory(h: DbHistory, actorNames: Map<string, string>): HistoryRow {
  return {
    id: h.id,
    ticketId: h.ticketId,
    unitId: h.unitId,
    entry: h.entry,
    attachmentKeys: h.attachmentKeys,
    actor: { id: h.actorUserId, fullName: actorNames.get(h.actorUserId) ?? "" },
    ticket: h.ticket
      ? { id: h.ticket.id, title: h.ticket.title, status: h.ticket.status as TicketStatus }
      : null,
    occurredOn: h.occurredOn.toISOString(),
    createdAt: h.createdAt.toISOString(),
  };
}

/** Batch actor join — one getUsersByIds call regardless of list length. */
async function mapHistoryRows(orgId: string, rows: DbHistory[]): Promise<HistoryRow[]> {
  const ids = [...new Set(rows.map((r) => r.actorUserId))];
  const users = await getUsersByIds(orgId, ids);
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  return rows.map((r) => mapHistory(r, names));
}

export async function createTicketService(
  ctx: TasksActorCtx,
  input: CreateTicketInput,
): Promise<TasksServiceResult<TicketRow>> {
  const unit = await findListing(ctx.orgId, input.unitId);
  if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  // Same assignee rule as createTaskService — the seed lands on the spawned task.
  if (input.assigneeUserId) {
    const operator = await findActiveOperator(ctx.orgId, input.assigneeUserId);
    if (!operator) {
      return { ok: false as const, status: 400, error: "Assignee must be an active admin user" };
    }
  }

  const created = await withTransaction(async (tx) => {
    const row = await createTicketRow(tx, {
      organizationId: ctx.orgId,
      unitId: input.unitId,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      status: "open",
      warrantyFlag: input.warrantyFlag,
      createdBy: ctx.actorUserId,
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "tasks.ticket.create",
      entityType: "Ticket",
      entityId: row.id,
      diff: { after: row } as unknown as Prisma.InputJsonValue,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await spawnTaskForTicket(tx, ctx, row, {
      priority: input.priority,
      assigneeUserId: input.assigneeUserId ?? null,
      dueOn: input.dueOn ? new Date(input.dueOn) : null,
    });
    return row;
  });

  return { ok: true as const, status: 201, data: mapTicketRow(created) };
}

export async function listUnitTicketsService(
  ctx: TasksActorCtx,
  unitId: string,
  query: ListTicketsQueryInput,
): Promise<TasksServiceResult<TicketRow[]>> {
  const unit = await findListing(ctx.orgId, unitId);
  if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  const rows = await listUnitTickets(ctx.orgId, unitId, {
    status: query.status,
    category: query.category,
    warrantyFlag: query.warrantyFlag === undefined ? undefined : query.warrantyFlag === "true",
  });
  return { ok: true as const, status: 200, data: rows.map(mapTicketRow) };
}

export async function getTicketService(
  ctx: TasksActorCtx,
  ticketId: string,
): Promise<TasksServiceResult<TicketRow>> {
  const ticket = await findTicket(ctx.orgId, ticketId);
  if (!ticket) return { ok: false as const, status: 404, error: "Ticket not found" };
  return { ok: true as const, status: 200, data: mapTicketRow(ticket) };
}

export async function updateTicketService(
  ctx: TasksActorCtx,
  input: UpdateTicketInput,
): Promise<TasksServiceResult<TicketRow>> {
  const existing = await findTicket(ctx.orgId, input.ticketId);
  if (!existing) return { ok: false as const, status: 404, error: "Ticket not found" };
  if (!TICKET_OPEN.has(existing.status)) {
    return { ok: false as const, status: 409, error: CLOSED_409 };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateTicketGuarded(tx, ctx.orgId, input.ticketId, input.updatedAt, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.warrantyFlag !== undefined ? { warrantyFlag: input.warrantyFlag } : {}),
        // Schema limits status edits to open|in_progress — resolve/void/reopen
        // own the closed transitions.
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      // Shared-field edits mirror onto the open paired task (no-op when none).
      await mirrorTaskFieldsFromTicket(tx, ctx, input.ticketId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      });
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.update",
        entityType: "Ticket",
        entityId: row.id,
        diff: { before: existing, after: row } as unknown as Prisma.InputJsonValue,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 200, data: mapTicketRow(updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function resolveTicketService(
  ctx: TasksActorCtx,
  input: ResolveTicketInput,
): Promise<TasksServiceResult<{ ticket: TicketRow; history: HistoryRow }>> {
  const existing = await findTicket(ctx.orgId, input.ticketId);
  if (!existing) return { ok: false as const, status: 404, error: "Ticket not found" };
  if (!TICKET_OPEN.has(existing.status)) {
    return { ok: false as const, status: 409, error: CLOSED_409 };
  }
  // Keys must be validated BEFORE the tx — a bad key is a 400, not a rollback.
  const keyError = await validateHistoryKeys(existing.unitId, input.attachmentKeys);
  if (keyError) return { ok: false as const, status: 400, error: keyError };

  try {
    const { ticket, history } = await withTransaction(async (tx) => {
      const updated = await updateTicketGuarded(tx, ctx.orgId, input.ticketId, input.updatedAt, {
        status: "resolved",
        resolvedAt: new Date(),
      });
      const historyRow = await createHistoryRow(tx, {
        organizationId: ctx.orgId,
        ticketId: input.ticketId,
        unitId: existing.unitId,
        entry: input.entry,
        attachmentKeys: input.attachmentKeys,
        actorUserId: ctx.actorUserId,
        occurredOn: new Date(input.occurredOn),
      });
      await mirrorTaskFromTicket(tx, ctx, input.ticketId, "done");
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.resolve",
        entityType: "Ticket",
        entityId: updated.id,
        meta: { historyId: historyRow.id, fromStatus: existing.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      // Re-read so the returned historyCount includes the entry just written.
      const fresh = await findTicketInTx(tx, ctx.orgId, updated.id);
      if (!fresh) throw new StaleUpdateError();
      return { ticket: fresh, history: historyRow };
    });
    const [mappedHistory] = await mapHistoryRows(ctx.orgId, [history]);
    return {
      ok: true as const,
      status: 200,
      data: { ticket: mapTicketRow(ticket), history: mappedHistory! },
    };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function voidTicketService(
  ctx: TasksActorCtx,
  input: { ticketId: string; updatedAt: string },
): Promise<TasksServiceResult<TicketRow>> {
  const existing = await findTicket(ctx.orgId, input.ticketId);
  if (!existing) return { ok: false as const, status: 404, error: "Ticket not found" };
  if (!TICKET_OPEN.has(existing.status)) {
    return { ok: false as const, status: 409, error: CLOSED_409 };
  }

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateTicketGuarded(tx, ctx.orgId, input.ticketId, input.updatedAt, {
        status: "void",
      });
      await mirrorTaskFromTicket(tx, ctx, input.ticketId, "archived");
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.void",
        entityType: "Ticket",
        entityId: row.id,
        meta: { fromStatus: existing.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 200, data: mapTicketRow(updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function reopenTicketService(
  ctx: TasksActorCtx,
  input: { ticketId: string; updatedAt: string },
): Promise<TasksServiceResult<TicketRow>> {
  const existing = await findTicket(ctx.orgId, input.ticketId);
  if (!existing) return { ok: false as const, status: 404, error: "Ticket not found" };
  // resolved → back to in_progress (work resumed); void → back to open (raised anew).
  const target =
    existing.status === "resolved" ? "in_progress" : existing.status === "void" ? "open" : null;
  if (!target) return { ok: false as const, status: 409, error: "Ticket is not closed" };

  try {
    const updated = await withTransaction(async (tx) => {
      const row = await updateTicketGuarded(tx, ctx.orgId, input.ticketId, input.updatedAt, {
        status: target,
        // A reopened ticket is no longer resolved — clear the stamp on both
        // paths (no-op for void, which never had one); resolve re-stamps it.
        resolvedAt: null,
      });
      // Pull the closed paired task back onto the board (resolved → its done
      // task revives into in_progress; void → its archived task restores).
      await reopenTaskFromTicket(
        tx,
        ctx,
        input.ticketId,
        existing.status as "resolved" | "void",
      );
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "tasks.ticket.reopen",
        entityType: "Ticket",
        entityId: row.id,
        meta: { from: existing.status, to: target },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return { ok: true as const, status: 200, data: mapTicketRow(updated) };
  } catch (err) {
    if (err instanceof StaleUpdateError) {
      return { ok: false as const, status: 409, error: STALE };
    }
    throw err;
  }
}

export async function listUnitHistoryService(
  ctx: TasksActorCtx,
  unitId: string,
): Promise<TasksServiceResult<HistoryRow[]>> {
  const unit = await findListing(ctx.orgId, unitId);
  if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  const rows = await listUnitHistory(ctx.orgId, unitId);
  return { ok: true as const, status: 200, data: await mapHistoryRows(ctx.orgId, rows) };
}

export async function quickLogService(
  ctx: TasksActorCtx,
  input: QuickLogInput,
): Promise<TasksServiceResult<{ history: HistoryRow; ticketId: string }>> {
  const unit = await findListing(ctx.orgId, input.unitId);
  if (!unit) return { ok: false as const, status: 404, error: "Unit not found" };
  // Keys must be validated BEFORE the tx — a bad key is a 400, not a rollback.
  const keyError = await validateHistoryKeys(input.unitId, input.attachmentKeys);
  if (keyError) return { ok: false as const, status: 400, error: keyError };

  const { history, ticketId } = await withTransaction(async (tx) => {
    const ticket = await createTicketRow(tx, {
      organizationId: ctx.orgId,
      unitId: input.unitId,
      title:
        input.title ??
        (input.entry.length > 80 ? `${input.entry.slice(0, 77)}…` : input.entry),
      description: null,
      category: input.category ?? null,
      status: "resolved",
      warrantyFlag: input.warrantyFlag,
      resolvedAt: new Date(),
      createdBy: ctx.actorUserId,
    });
    const historyRow = await createHistoryRow(tx, {
      organizationId: ctx.orgId,
      ticketId: ticket.id,
      unitId: input.unitId,
      entry: input.entry,
      attachmentKeys: input.attachmentKeys,
      actorUserId: ctx.actorUserId,
      occurredOn: new Date(input.occurredOn),
    });
    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "tasks.history.quicklog",
      entityType: "TicketHistory",
      entityId: historyRow.id,
      meta: { ticketId: ticket.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { history: historyRow, ticketId: ticket.id };
  });

  const [mappedHistory] = await mapHistoryRows(ctx.orgId, [history]);
  return { ok: true as const, status: 201, data: { history: mappedHistory!, ticketId } };
}
