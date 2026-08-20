import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../tasks.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  findListing: vi.fn(async () => null),
  findActiveOperator: vi.fn(async () => null),
  getUsersByIds: vi.fn(async () => []),
}));

vi.mock("../tasks-media.service", () => ({
  validateHistoryKeys: vi.fn(async () => null),
}));

vi.mock("../tickets.repository", () => ({
  listUnitTickets: vi.fn(async () => []),
  findTicket: vi.fn(async () => null),
  findTicketInTx: vi.fn(async () => null),
  createTicketRow: vi.fn(),
  updateTicketGuarded: vi.fn(),
  listUnitHistory: vi.fn(async () => []),
  createHistoryRow: vi.fn(),
}));

vi.mock("../mirror", () => ({
  spawnTaskForTicket: vi.fn(async () => undefined),
  mirrorTaskFromTicket: vi.fn(async () => undefined),
  mirrorTaskFieldsFromTicket: vi.fn(async () => undefined),
  reopenTaskFromTicket: vi.fn(async () => undefined),
}));

import { recordAudit } from "../../../lib/audit";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import { findActiveOperator, findListing, getUsersByIds, withTransaction } from "../tasks.repository";
import { validateHistoryKeys } from "../tasks-media.service";
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
} from "../tickets.repository";
import {
  mirrorTaskFieldsFromTicket,
  mirrorTaskFromTicket,
  reopenTaskFromTicket,
  spawnTaskForTicket,
} from "../mirror";
import {
  createTicketService,
  getTicketService,
  listUnitHistoryService,
  listUnitTicketsService,
  quickLogService,
  reopenTicketService,
  resolveTicketService,
  updateTicketService,
  voidTicketService,
} from "../tickets.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const UNIT = "00000000-0000-0000-0000-0000000000cc";
const TICKET = "00000000-0000-0000-0000-0000000000dd";
const HISTORY = "00000000-0000-0000-0000-0000000000ee";
const ISO = "2026-06-01T00:00:00.000Z";
const OCCURRED = "2026-06-10T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "manager" as const };

const STALE = "Record changed — reloaded";
const CLOSED = "Ticket is closed — reopen it first";

function dbTicket(overrides: Partial<DbTicket> = {}): DbTicket {
  return {
    id: TICKET,
    unitId: UNIT,
    title: "Leaky tap",
    description: null,
    category: null,
    status: "open",
    warrantyFlag: false,
    attachmentKeys: [],
    resolvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    _count: { history: 0 },
    ...overrides,
  } as DbTicket;
}

function dbHistory(overrides: Partial<DbHistory> = {}): DbHistory {
  return {
    id: HISTORY,
    ticketId: TICKET,
    unitId: UNIT,
    entry: "Replaced washer",
    attachmentKeys: [],
    actorUserId: ACTOR,
    occurredOn: new Date(OCCURRED),
    createdAt: new Date(ISO),
    ticket: { id: TICKET, title: "Leaky tap", status: "resolved" },
    ...overrides,
  } as DbHistory;
}

/** Data arg of the n-th updateTicketGuarded call — (tx, orgId, ticketId, updatedAt, data). */
function guardedData(call = 0): Record<string, unknown> {
  return vi.mocked(updateTicketGuarded).mock.calls[call]![4] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findTicket).mockResolvedValue(null);
  vi.mocked(findTicketInTx).mockResolvedValue(dbTicket());
  vi.mocked(findListing).mockResolvedValue(null);
  vi.mocked(validateHistoryKeys).mockResolvedValue(null);
  vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket());
  vi.mocked(createTicketRow).mockResolvedValue(dbTicket());
  vi.mocked(createHistoryRow).mockResolvedValue(dbHistory());
  vi.mocked(listUnitTickets).mockResolvedValue([]);
  vi.mocked(listUnitHistory).mockResolvedValue([]);
  vi.mocked(getUsersByIds).mockResolvedValue([]);
});

describe("createTicketService", () => {
  it("returns 404 Unit not found for an unknown unit", async () => {
    const result = await createTicketService(ctx, {
      unitId: UNIT,
      title: "Leaky tap",
      warrantyFlag: false,
      priority: "medium",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("creates an open ticket and audits tasks.ticket.create in the same tx", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    const result = await createTicketService(ctx, {
      unitId: UNIT,
      title: "Leaky tap",
      warrantyFlag: true,
      priority: "medium",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(201);
    expect(createTicketRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        unitId: UNIT,
        status: "open",
        warrantyFlag: true,
        createdBy: ACTOR,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.ticket.create", entityType: "Ticket" }),
    );
    expect(spawnTaskForTicket).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: TICKET }),
      { priority: "medium", assigneeUserId: null, dueOn: null },
    );
  });

  it("passes the task seed (priority/assignee/dueOn) through to the spawned task", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(findActiveOperator).mockResolvedValue({ id: ACTOR } as never);
    const result = await createTicketService(ctx, {
      unitId: UNIT,
      title: "Leaky tap",
      warrantyFlag: false,
      priority: "high",
      assigneeUserId: ACTOR,
      dueOn: OCCURRED,
    });
    expect(result.ok).toBe(true);
    expect(findActiveOperator).toHaveBeenCalledWith(ORG, ACTOR);
    expect(spawnTaskForTicket).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: TICKET }),
      { priority: "high", assigneeUserId: ACTOR, dueOn: new Date(OCCURRED) },
    );
  });

  it("returns 400 when the assignee is not an active admin user", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(findActiveOperator).mockResolvedValue(null as never);
    const result = await createTicketService(ctx, {
      unitId: UNIT,
      title: "Leaky tap",
      warrantyFlag: false,
      priority: "medium",
      assigneeUserId: ACTOR,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Assignee must be an active admin user",
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe("listUnitTicketsService", () => {
  it("returns 404 Unit not found for an unknown unit", async () => {
    const result = await listUnitTicketsService(ctx, UNIT, {});
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
  });

  it('converts warrantyFlag "true" to boolean true for the repository', async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    await listUnitTicketsService(ctx, UNIT, { warrantyFlag: "true" });
    expect(listUnitTickets).toHaveBeenCalledWith(ORG, UNIT, {
      status: undefined,
      category: undefined,
      warrantyFlag: true,
    });
  });

  it('converts warrantyFlag "false" to boolean false for the repository', async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    await listUnitTicketsService(ctx, UNIT, { warrantyFlag: "false", status: "open" });
    expect(listUnitTickets).toHaveBeenCalledWith(ORG, UNIT, {
      status: "open",
      category: undefined,
      warrantyFlag: false,
    });
  });

  it("passes warrantyFlag undefined when absent", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    await listUnitTicketsService(ctx, UNIT, {});
    expect(listUnitTickets).toHaveBeenCalledWith(ORG, UNIT, {
      status: undefined,
      category: undefined,
      warrantyFlag: undefined,
    });
  });

  it("maps DbTicket → TicketRow: _count.history → historyCount, ISO dates", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(listUnitTickets).mockResolvedValue([
      dbTicket({
        status: "resolved",
        resolvedAt: new Date(OCCURRED),
        _count: { history: 3 },
      }),
    ]);
    const result = await listUnitTicketsService(ctx, UNIT, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.data[0]!;
    expect(row.historyCount).toBe(3);
    expect(row).not.toHaveProperty("_count");
    expect(row.resolvedAt).toBe(OCCURRED);
    expect(row.createdAt).toBe(ISO);
    expect(row.updatedAt).toBe(ISO);
  });
});

describe("getTicketService", () => {
  it("returns 404 when the ticket does not exist", async () => {
    const result = await getTicketService(ctx, TICKET);
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it("returns the mapped ticket", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ _count: { history: 2 } }));
    const result = await getTicketService(ctx, TICKET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.historyCount).toBe(2);
  });
});

describe("updateTicketService", () => {
  it("returns 404 when the ticket does not exist", async () => {
    const result = await updateTicketService(ctx, { ticketId: TICKET, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it("returns 409 with the exact closed message for a resolved ticket", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    const result = await updateTicketService(ctx, { ticketId: TICKET, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
  });

  it("returns 409 with the exact closed message for a void ticket", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "void" }));
    const result = await updateTicketService(ctx, { ticketId: TICKET, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
  });

  it("only writes the provided fields and audits tasks.ticket.update with a before/after diff", async () => {
    const existing = dbTicket();
    vi.mocked(findTicket).mockResolvedValue(existing);
    const after = dbTicket({ title: "New title", status: "in_progress" });
    vi.mocked(updateTicketGuarded).mockResolvedValue(after);
    const result = await updateTicketService(ctx, {
      ticketId: TICKET,
      updatedAt: ISO,
      title: "New title",
      status: "in_progress",
    });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ title: "New title", status: "in_progress" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.ticket.update",
        entityType: "Ticket",
        diff: { before: existing, after },
      }),
    );
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket());
    vi.mocked(updateTicketGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await updateTicketService(ctx, { ticketId: TICKET, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("resolveTicketService", () => {
  const input = {
    ticketId: TICKET,
    updatedAt: ISO,
    entry: "Replaced washer",
    attachmentKeys: [],
    occurredOn: OCCURRED,
  };

  it("returns 404 when the ticket does not exist", async () => {
    const result = await resolveTicketService(ctx, input);
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it("returns 409 with the closed message when already resolved", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    const result = await resolveTicketService(ctx, input);
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
  });

  it("returns 409 with the closed message when void", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "void" }));
    const result = await resolveTicketService(ctx, input);
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
  });

  it("returns 400 with the validator's message and opens NO tx on a bad attachment key", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(validateHistoryKeys).mockResolvedValue("Invalid attachment key");
    const result = await resolveTicketService(ctx, {
      ...input,
      attachmentKeys: ["unit-history/evil/k.jpg"],
    });
    expect(result).toEqual({ ok: false, status: 400, error: "Invalid attachment key" });
    expect(validateHistoryKeys).toHaveBeenCalledWith(UNIT, ["unit-history/evil/k.jpg"]);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("writes the history entry in the same tx with the ticket's unitId, the actor, and occurredOn", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "in_progress" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(
      dbTicket({ status: "resolved", _count: { history: 1 } }),
    );
    const result = await resolveTicketService(ctx, input);
    expect(result.ok).toBe(true);
    expect(guardedData()).toMatchObject({ status: "resolved" });
    expect((guardedData() as { resolvedAt: unknown }).resolvedAt).toBeInstanceOf(Date);
    expect(createHistoryRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        ticketId: TICKET,
        unitId: UNIT,
        entry: "Replaced washer",
        actorUserId: ACTOR,
        occurredOn: new Date(OCCURRED),
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.ticket.resolve",
        entityType: "Ticket",
        meta: { historyId: HISTORY, fromStatus: "in_progress" },
      }),
    );
  });

  it("re-reads in-tx so the returned historyCount includes the new entry (N → N+1)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open", _count: { history: 4 } }));
    // The guarded update still sees the pre-insert count; the post-insert
    // re-read is what carries the +1.
    vi.mocked(updateTicketGuarded).mockResolvedValue(
      dbTicket({ status: "resolved", _count: { history: 4 } }),
    );
    vi.mocked(findTicketInTx).mockResolvedValue(
      dbTicket({ status: "resolved", _count: { history: 5 } }),
    );
    const result = await resolveTicketService(ctx, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ticket.historyCount).toBe(5);
    expect(result.data.history.id).toBe(HISTORY);
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await resolveTicketService(ctx, input);
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
    expect(createHistoryRow).not.toHaveBeenCalled();
  });

  it("maps a null in-tx re-read to a 409 with the stale message (no silent fallback)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "resolved" }));
    vi.mocked(findTicketInTx).mockResolvedValue(null);
    const result = await resolveTicketService(ctx, input);
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("voidTicketService", () => {
  it("returns 404 when the ticket does not exist", async () => {
    const result = await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it("returns 409 with the closed message for a resolved ticket", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    const result = await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
  });

  it("voids an open ticket and audits tasks.ticket.void with the fromStatus", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "void" }));
    const result = await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ status: "void" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.ticket.void", meta: { fromStatus: "open" } }),
    );
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "in_progress" }));
    vi.mocked(updateTicketGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("reopenTicketService", () => {
  it("returns 404 when the ticket does not exist", async () => {
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it('returns 409 "Ticket is not closed" for an open ticket', async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: "Ticket is not closed" });
  });

  it("reopens a resolved ticket to in_progress, clears resolvedAt, and audits from/to", async () => {
    vi.mocked(findTicket).mockResolvedValue(
      dbTicket({ status: "resolved", resolvedAt: new Date(OCCURRED) }),
    );
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "in_progress" }));
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ status: "in_progress", resolvedAt: null });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.ticket.reopen",
        meta: { from: "resolved", to: "in_progress" },
      }),
    );
  });

  it("reopens a void ticket to open (resolvedAt cleared too — harmless no-op on void)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "void" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "open" }));
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ status: "open", resolvedAt: null });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ meta: { from: "void", to: "open" } }),
    );
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    vi.mocked(updateTicketGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });

  it("revives the paired closed task in the same transaction (resolved reopen)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "in_progress" }));
    const result = await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(vi.mocked(reopenTaskFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      "resolved",
    );
  });

  it("revives the paired archived task on a void reopen", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "void" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "open" }));
    await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(vi.mocked(reopenTaskFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      "void",
    );
  });

  it("does NOT touch tasks when reopen is rejected (ticket not closed)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    await reopenTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(vi.mocked(reopenTaskFromTicket)).not.toHaveBeenCalled();
  });
});

// ── Punch list #5: ticket field edits mirror to the paired task ──────────────

describe("updateTicketService — shared-field mirror", () => {
  it("mirrors title/description/category edits to the open paired task", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ category: "Plumbing" }));
    const result = await updateTicketService(ctx, {
      ticketId: TICKET,
      updatedAt: ISO,
      title: "Leaky tap (kitchen)",
      category: "Plumbing",
    });
    expect(result.ok).toBe(true);
    expect(vi.mocked(mirrorTaskFieldsFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      { title: "Leaky tap (kitchen)", category: "Plumbing" },
    );
  });

  it("passes only shared fields — warrantyFlag/status stay ticket-side", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ warrantyFlag: true }));
    await updateTicketService(ctx, {
      ticketId: TICKET,
      updatedAt: ISO,
      warrantyFlag: true,
      status: "in_progress",
    });
    expect(vi.mocked(mirrorTaskFieldsFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      {},
    );
  });

  it("does not mirror when the update is rejected (closed ticket)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    const result = await updateTicketService(ctx, {
      ticketId: TICKET,
      updatedAt: ISO,
      category: "Plumbing",
    });
    expect(result).toEqual({ ok: false, status: 409, error: CLOSED });
    expect(vi.mocked(mirrorTaskFieldsFromTicket)).not.toHaveBeenCalled();
  });
});

describe("listUnitHistoryService", () => {
  it("returns 404 Unit not found for an unknown unit", async () => {
    const result = await listUnitHistoryService(ctx, UNIT);
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
  });

  it("maps rows with a batched actor join and the embedded ticket", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(listUnitHistory).mockResolvedValue([dbHistory(), dbHistory({ id: HISTORY })]);
    vi.mocked(getUsersByIds).mockResolvedValue([{ id: ACTOR, fullName: "Ops One", photoKey: null }]);
    const result = await listUnitHistoryService(ctx, UNIT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.actor).toEqual({ id: ACTOR, fullName: "Ops One" });
    expect(result.data[0]!.ticket).toEqual({ id: TICKET, title: "Leaky tap", status: "resolved" });
    expect(result.data[0]!.occurredOn).toBe(OCCURRED);
    // Batch join: one lookup for the whole list, de-duplicated ids.
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUsersByIds).toHaveBeenCalledWith(ORG, [ACTOR]);
  });
});

describe("quickLogService", () => {
  const input = {
    unitId: UNIT,
    entry: "1701 kitchen light replaced",
    occurredOn: OCCURRED,
    attachmentKeys: [],
    warrantyFlag: false,
  };

  it("returns 404 Unit not found for an unknown unit", async () => {
    const result = await quickLogService(ctx, input);
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 with the validator's message and opens NO tx on a bad attachment key", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(validateHistoryKeys).mockResolvedValue("Attachment not found in storage");
    const result = await quickLogService(ctx, {
      ...input,
      attachmentKeys: [`unit-history/${UNIT}/missing.jpg`],
    });
    expect(result).toEqual({ ok: false, status: 400, error: "Attachment not found in storage" });
    expect(withTransaction).not.toHaveBeenCalled();
    expect(createTicketRow).not.toHaveBeenCalled();
  });

  it("creates a resolved ticket + history entry in one tx and audits tasks.history.quicklog", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(createTicketRow).mockResolvedValue(dbTicket({ status: "resolved" }));
    const result = await quickLogService(ctx, input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.data.ticketId).toBe(TICKET);
    }
    expect(createTicketRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        unitId: UNIT,
        status: "resolved",
        description: null,
        createdBy: ACTOR,
      }),
    );
    const ticketData = vi.mocked(createTicketRow).mock.calls[0]![1] as { resolvedAt: unknown };
    expect(ticketData.resolvedAt).toBeInstanceOf(Date);
    expect(createHistoryRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ticketId: TICKET,
        unitId: UNIT,
        entry: input.entry,
        actorUserId: ACTOR,
        occurredOn: new Date(OCCURRED),
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.history.quicklog",
        entityType: "TicketHistory",
        entityId: HISTORY,
        meta: { ticketId: TICKET },
      }),
    );
  });

  it("uses the entry verbatim as the ticket title when it is 80 chars or fewer", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    const entry = "x".repeat(80);
    await quickLogService(ctx, { ...input, entry });
    expect(createTicketRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: entry }),
    );
  });

  it("truncates entries over 80 chars to 77 + … for the ticket title", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    const entry = "x".repeat(100);
    await quickLogService(ctx, { ...input, entry });
    expect(createTicketRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: `${"x".repeat(77)}…` }),
    );
  });

  it("prefers an explicit title over the derived one", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    await quickLogService(ctx, { ...input, title: "Kitchen light" });
    expect(createTicketRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Kitchen light" }),
    );
  });
});

// ── Task 1.3: createTicketService auto-spawns a paired task ──────────────────

describe("createTicketService — mirror spawn (Task 1.3)", () => {
  it("calls spawnTaskForTicket exactly once in the same tx when a unit is found", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT });
    vi.mocked(createTicketRow).mockResolvedValue(dbTicket());
    await createTicketService(ctx, { unitId: UNIT, title: "AC broken", warrantyFlag: false, priority: "medium" });
    expect(vi.mocked(spawnTaskForTicket)).toHaveBeenCalledTimes(1);
  });

  it("does NOT call spawnTaskForTicket when unit is not found (returns early)", async () => {
    // findListing returns null (default) — service returns 404 before opening any tx
    await createTicketService(ctx, { unitId: UNIT, title: "AC broken", warrantyFlag: false, priority: "medium" });
    expect(vi.mocked(spawnTaskForTicket)).not.toHaveBeenCalled();
  });
});

// ── Task 1.4: resolveTicketService + voidTicketService mirror the paired task ─

describe("resolveTicketService — mirror to task done (Task 1.4)", () => {
  const resolveInput = {
    ticketId: TICKET,
    updatedAt: ISO,
    entry: "Fixed",
    attachmentKeys: [],
    occurredOn: OCCURRED,
  };

  it("calls mirrorTaskFromTicket with 'done' when a ticket is successfully resolved", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "resolved" }));
    vi.mocked(findTicketInTx).mockResolvedValue(dbTicket({ status: "resolved", _count: { history: 1 } }));
    await resolveTicketService(ctx, resolveInput);
    expect(vi.mocked(mirrorTaskFromTicket)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mirrorTaskFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      "done",
    );
  });

  it("does NOT call mirrorTaskFromTicket when resolve is blocked (ticket already closed)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    await resolveTicketService(ctx, resolveInput);
    expect(vi.mocked(mirrorTaskFromTicket)).not.toHaveBeenCalled();
  });
});

describe("voidTicketService — mirror to task archived (Task 1.4)", () => {
  it("calls mirrorTaskFromTicket with 'archived' when a ticket is successfully voided", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "open" }));
    vi.mocked(updateTicketGuarded).mockResolvedValue(dbTicket({ status: "void" }));
    await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(vi.mocked(mirrorTaskFromTicket)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mirrorTaskFromTicket)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      "archived",
    );
  });

  it("does NOT call mirrorTaskFromTicket when void is blocked (ticket already resolved)", async () => {
    vi.mocked(findTicket).mockResolvedValue(dbTicket({ status: "resolved" }));
    await voidTicketService(ctx, { ticketId: TICKET, updatedAt: ISO });
    expect(vi.mocked(mirrorTaskFromTicket)).not.toHaveBeenCalled();
  });
});
