import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { StaleUpdateError } from "../../lib/concurrency-error";

const TICKET_SELECT = {
  id: true,
  unitId: true,
  title: true,
  description: true,
  category: true,
  status: true,
  warrantyFlag: true,
  attachmentKeys: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { history: true } },
} satisfies Prisma.TicketSelect;

export type DbTicket = Prisma.TicketGetPayload<{ select: typeof TICKET_SELECT }>;

export async function listUnitTickets(
  orgId: string,
  unitId: string,
  filters: { status?: string; category?: string; warrantyFlag?: boolean },
): Promise<DbTicket[]> {
  const db = getDb();
  return db.ticket.findMany({
    where: {
      organizationId: orgId,
      unitId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.warrantyFlag !== undefined ? { warrantyFlag: filters.warrantyFlag } : {}),
    },
    select: TICKET_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

export async function findTicket(orgId: string, ticketId: string): Promise<DbTicket | null> {
  const db = getDb();
  return db.ticket.findFirst({
    where: { id: ticketId, organizationId: orgId },
    select: TICKET_SELECT,
  });
}

/** In-transaction variant of findTicket — used to re-read a row mid-tx (e.g. after resolve's history insert). */
export async function findTicketInTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  ticketId: string,
): Promise<DbTicket | null> {
  return tx.ticket.findFirst({
    where: { id: ticketId, organizationId: orgId },
    select: TICKET_SELECT,
  });
}

export async function createTicketRow(
  tx: Prisma.TransactionClient,
  data: Prisma.TicketUncheckedCreateInput,
): Promise<DbTicket> {
  return tx.ticket.create({ data, select: TICKET_SELECT });
}

/**
 * Optimistic-concurrency guarded update: the WHERE carries both the org scope
 * and the expected `updatedAt`. `count === 0` means the row was modified (or
 * deleted) since the caller's read — surfaced as StaleUpdateError → 409.
 */
export async function updateTicketGuarded(
  tx: Prisma.TransactionClient,
  orgId: string,
  ticketId: string,
  expectedUpdatedAt: string,
  data: Prisma.TicketUncheckedUpdateManyInput,
): Promise<DbTicket> {
  const result = await tx.ticket.updateMany({
    where: { id: ticketId, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data,
  });
  if (result.count === 0) throw new StaleUpdateError();
  const fresh = await findTicketInTx(tx, orgId, ticketId);
  if (!fresh) throw new StaleUpdateError();
  return fresh;
}

// ─── History (immutable — create + list only, no update/delete by design) ────

const HISTORY_SELECT = {
  id: true,
  ticketId: true,
  unitId: true,
  entry: true,
  attachmentKeys: true,
  actorUserId: true,
  occurredOn: true,
  createdAt: true,
  ticket: { select: { id: true, title: true, status: true } },
} satisfies Prisma.TicketHistorySelect;

export type DbHistory = Prisma.TicketHistoryGetPayload<{ select: typeof HISTORY_SELECT }>;

export async function listUnitHistory(orgId: string, unitId: string): Promise<DbHistory[]> {
  const db = getDb();
  return db.ticketHistory.findMany({
    where: { organizationId: orgId, unitId },
    select: HISTORY_SELECT,
    orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
  });
}

export async function createHistoryRow(
  tx: Prisma.TransactionClient,
  data: Prisma.TicketHistoryUncheckedCreateInput,
): Promise<DbHistory> {
  return tx.ticketHistory.create({ data, select: HISTORY_SELECT });
}

// ─── Cascade helpers for task hard-delete ────────────────────────────────────

/**
 * Collect all storage keys for a ticket + its history rows.
 * Called BEFORE the transaction so the keys are available even after deletion.
 */
export async function collectTicketStorageKeys(
  orgId: string,
  ticketId: string,
): Promise<string[]> {
  const db = getDb();
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, organizationId: orgId },
    select: { attachmentKeys: true },
  });
  if (!ticket) return [];
  const history = await db.ticketHistory.findMany({
    where: { ticketId, organizationId: orgId },
    select: { attachmentKeys: true },
  });
  return [...ticket.attachmentKeys, ...history.flatMap((h) => h.attachmentKeys)];
}

/**
 * Delete all TicketHistory rows then the Ticket itself — must be run inside a
 * transaction. History rows carry `onDelete: Restrict` on the ticket FK, so
 * they must be removed first.
 */
export async function deleteTicketCascade(
  tx: Prisma.TransactionClient,
  orgId: string,
  ticketId: string,
): Promise<void> {
  await tx.ticketHistory.deleteMany({ where: { ticketId, organizationId: orgId } });
  await tx.ticket.deleteMany({ where: { id: ticketId, organizationId: orgId } });
}
