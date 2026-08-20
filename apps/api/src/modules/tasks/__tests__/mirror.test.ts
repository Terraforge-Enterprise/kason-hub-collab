import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tasks.repository", () => ({
  createTaskRow: vi.fn(),
  nextLaneSortOrder: vi.fn().mockResolvedValue(0),
  findOpenTaskByTicketId: vi.fn(),
  findClosedTaskByTicketId: vi.fn(),
}));
vi.mock("../tickets.repository", () => ({ createTicketRow: vi.fn(), createHistoryRow: vi.fn() }));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));

import {
  spawnTaskForTicket,
  spawnTicketForTask,
  mirrorTaskFromTicket,
  mirrorTicketFromTask,
  mirrorTaskFieldsFromTicket,
  mirrorTicketFieldsFromTask,
  reopenTaskFromTicket,
  reopenTicketFromTask,
} from "../mirror";
import * as taskRepo from "../tasks.repository";
import * as ticketRepo from "../tickets.repository";
import { recordAudit } from "../../../lib/audit";

const tx = {} as any;
const ctx = { orgId: "o1", actorUserId: "u1", actorRole: "editor" as const };
beforeEach(() => vi.clearAllMocks());

it("spawnTaskForTicket creates a pool task carrying ticketId + inherited fields", async () => {
  vi.mocked(taskRepo.createTaskRow).mockResolvedValue({ id: "t1" } as any);
  await spawnTaskForTicket(tx, ctx, { id: "k1", unitId: "unit1", title: "AC", description: null, category: "Aircond/HVAC" } as any);
  const arg = vi.mocked(taskRepo.createTaskRow).mock.calls[0][1];
  expect(arg).toMatchObject({ status: "pool", ticketId: "k1", relatedUnitId: "unit1", title: "AC", category: "Aircond/HVAC", assigneeUserId: null });
});

it("spawnTaskForTicket with a seed lands in todo with assignedAt + priority + dueOn", async () => {
  vi.mocked(taskRepo.createTaskRow).mockResolvedValue({ id: "t1" } as any);
  const dueOn = new Date("2026-08-15T00:00:00.000Z");
  await spawnTaskForTicket(
    tx,
    ctx,
    { id: "k1", unitId: "unit1", title: "AC", description: null, category: null } as any,
    { priority: "high", assigneeUserId: "u9", dueOn },
  );
  expect(vi.mocked(taskRepo.nextLaneSortOrder)).toHaveBeenCalledWith(tx, "o1", "todo");
  const arg = vi.mocked(taskRepo.createTaskRow).mock.calls[0][1];
  expect(arg).toMatchObject({ status: "todo", priority: "high", assigneeUserId: "u9", dueOn });
  expect((arg as any).assignedAt).toBeInstanceOf(Date);
});

it("spawnTaskForTicket records an audit row", async () => {
  vi.mocked(taskRepo.createTaskRow).mockResolvedValue({ id: "t1" } as any);
  await spawnTaskForTicket(tx, ctx, { id: "k1", unitId: "unit1", title: "AC", description: null, category: null } as any);
  expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "tasks.task.spawn_from_ticket", entityId: "t1" }));
});

it("spawnTicketForTask creates an open ticket linked to the task's unit", async () => {
  vi.mocked(ticketRepo.createTicketRow).mockResolvedValue({ id: "k2" } as any);
  const ticketId = await spawnTicketForTask(tx, ctx, { id: "t2", relatedUnitId: "unit2", title: "Fix gate", description: null, category: "Locks/Access" });
  expect(ticketId).toBe("k2");
  const arg = vi.mocked(ticketRepo.createTicketRow).mock.calls[0][1];
  expect(arg).toMatchObject({ status: "open", unitId: "unit2", title: "Fix gate", category: "Locks/Access", warrantyFlag: false });
});

it("mirrorTaskFromTicket(done) completes the open linked task", async () => {
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue({ id: "t9", status: "in_progress" } as any);
  vi.mocked(taskRepo.createTaskRow); // noop
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  await mirrorTaskFromTicket(tx, ctx, "k1", "done");
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t9", organizationId: "o1" } }));
  const data = update.mock.calls[0][0].data;
  expect(data.status).toBe("done");
  expect(data.completedAt).toBeInstanceOf(Date);
});

it("mirrorTaskFromTicket(archived) sets task status to archived without completedAt", async () => {
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue({ id: "t10", status: "in_progress" } as any);
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  await mirrorTaskFromTicket(tx, ctx, "k1", "archived");
  const data = update.mock.calls[0][0].data;
  expect(data.status).toBe("archived");
  expect(data.completedAt).toBeUndefined();
});

it("mirrorTaskFromTicket no-ops when no open linked task", async () => {
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue(null);
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  await mirrorTaskFromTicket(tx, ctx, "k1", "done");
  expect(update).not.toHaveBeenCalled();
});

it("mirrorTicketFromTask(resolved) updates ticket status + writes history note", async () => {
  const ticketUpdate = vi.fn();
  const histCreate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  vi.mocked(ticketRepo.createHistoryRow).mockImplementation(histCreate);
  await mirrorTicketFromTask(tx, ctx, { id: "k3", unitId: "unit3", status: "open" }, "resolved");
  expect(ticketUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "k3", organizationId: "o1" } }));
  const data = ticketUpdate.mock.calls[0][0].data;
  expect(data.status).toBe("resolved");
  expect(data.resolvedAt).toBeInstanceOf(Date);
  expect(vi.mocked(ticketRepo.createHistoryRow)).toHaveBeenCalledWith(tx, expect.objectContaining({ entry: "Done on board.", ticketId: "k3", unitId: "unit3" }));
});

it("mirrorTicketFromTask(void) updates ticket status to void without history note", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  await mirrorTicketFromTask(tx, ctx, { id: "k4", unitId: "unit4", status: "open" }, "void");
  const data = ticketUpdate.mock.calls[0][0].data;
  expect(data.status).toBe("void");
  expect(vi.mocked(ticketRepo.createHistoryRow)).not.toHaveBeenCalled();
});

it("mirrorTicketFromTask no-ops when ticket already terminal", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  await mirrorTicketFromTask(tx, ctx, { id: "k5", unitId: "unit5", status: "resolved" }, "resolved");
  expect(ticketUpdate).not.toHaveBeenCalled();
  await mirrorTicketFromTask(tx, ctx, { id: "k6", unitId: "unit6", status: "void" }, "void");
  expect(ticketUpdate).not.toHaveBeenCalled();
});

it("mirrorTicketFromTask(in_progress) only mirrors from open status", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  // Already in_progress — should no-op
  await mirrorTicketFromTask(tx, ctx, { id: "k7", unitId: "unit7", status: "in_progress" }, "in_progress");
  expect(ticketUpdate).not.toHaveBeenCalled();
  // open → in_progress — should mirror
  await mirrorTicketFromTask(tx, ctx, { id: "k8", unitId: "unit8", status: "open" }, "in_progress");
  expect(ticketUpdate).toHaveBeenCalledTimes(1);
});

// ─── Pull-back / revival / field mirrors ─────────────────────────────────────

it("reopenTicketFromTask(in_progress lane) reopens a resolved ticket + history note", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  await reopenTicketFromTask(tx, ctx, { id: "k9", unitId: "unit9", status: "resolved" }, "in_progress");
  const call = ticketUpdate.mock.calls[0][0];
  expect(call.where).toEqual({ id: "k9", organizationId: "o1" });
  expect(call.data.status).toBe("in_progress");
  expect(call.data.resolvedAt).toBeNull();
  expect(vi.mocked(ticketRepo.createHistoryRow)).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ entry: "Reopened on board.", ticketId: "k9", unitId: "unit9" }),
  );
});

it("reopenTicketFromTask(todo/pool lane) reopens the ticket to open", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  await reopenTicketFromTask(tx, ctx, { id: "k10", unitId: "unit10", status: "resolved" }, "todo");
  expect(ticketUpdate.mock.calls[0][0].data.status).toBe("open");
});

it("reopenTicketFromTask no-ops for non-resolved tickets (open, void)", async () => {
  const ticketUpdate = vi.fn();
  (tx as any).ticket = { updateMany: ticketUpdate };
  await reopenTicketFromTask(tx, ctx, { id: "k11", unitId: "u", status: "open" }, "todo");
  await reopenTicketFromTask(tx, ctx, { id: "k12", unitId: "u", status: "void" }, "todo");
  expect(ticketUpdate).not.toHaveBeenCalled();
  expect(vi.mocked(ticketRepo.createHistoryRow)).not.toHaveBeenCalled();
});

it("reopenTaskFromTicket(resolved) revives the done task into in_progress", async () => {
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue(null);
  vi.mocked(taskRepo.findClosedTaskByTicketId).mockResolvedValue({
    id: "t20", assigneeUserId: null, startedAt: null,
  } as any);
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  await reopenTaskFromTicket(tx, ctx, "k20", "resolved");
  expect(vi.mocked(taskRepo.findClosedTaskByTicketId)).toHaveBeenCalledWith(tx, "o1", "k20", "done");
  const data = update.mock.calls[0][0].data;
  expect(data.status).toBe("in_progress");
  expect(data.completedAt).toBeNull();
  expect(data.startedAt).toBeInstanceOf(Date);
});

it("reopenTaskFromTicket(void) restores the archived task to todo/pool by assignee", async () => {
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue(null);
  vi.mocked(taskRepo.findClosedTaskByTicketId).mockResolvedValue({
    id: "t21", assigneeUserId: "u9", startedAt: null,
  } as any);
  await reopenTaskFromTicket(tx, ctx, "k21", "void");
  expect(vi.mocked(taskRepo.findClosedTaskByTicketId)).toHaveBeenCalledWith(tx, "o1", "k21", "archived");
  expect(update.mock.calls[0][0].data.status).toBe("todo");
  vi.mocked(taskRepo.findClosedTaskByTicketId).mockResolvedValue({
    id: "t22", assigneeUserId: null, startedAt: null,
  } as any);
  await reopenTaskFromTicket(tx, ctx, "k22", "void");
  expect(update.mock.calls[1][0].data.status).toBe("pool");
});

it("reopenTaskFromTicket no-ops when an open task exists or none is linked", async () => {
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue({ id: "t1", status: "todo" } as any);
  await reopenTaskFromTicket(tx, ctx, "k23", "resolved");
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue(null);
  vi.mocked(taskRepo.findClosedTaskByTicketId).mockResolvedValue(null);
  await reopenTaskFromTicket(tx, ctx, "k24", "resolved");
  expect(update).not.toHaveBeenCalled();
});

it("mirrorTaskFieldsFromTicket writes shared fields onto the open task, no-ops otherwise", async () => {
  const update = vi.fn();
  (tx as any).task = { updateMany: update };
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue({ id: "t30", status: "todo" } as any);
  await mirrorTaskFieldsFromTicket(tx, ctx, "k30", { category: "Plumbing", title: "T" });
  expect(update).toHaveBeenCalledWith({
    where: { id: "t30", organizationId: "o1" },
    data: { category: "Plumbing", title: "T" },
  });
  update.mockClear();
  await mirrorTaskFieldsFromTicket(tx, ctx, "k30", {});
  vi.mocked(taskRepo.findOpenTaskByTicketId).mockResolvedValue(null);
  await mirrorTaskFieldsFromTicket(tx, ctx, "k30", { title: "X" });
  expect(update).not.toHaveBeenCalled();
});

it("mirrorTicketFieldsFromTask targets only open/in_progress tickets and audits real writes only", async () => {
  const update = vi.fn(async () => ({ count: 1 }));
  (tx as any).ticket = { updateMany: update };
  await mirrorTicketFieldsFromTask(tx, ctx, "k40", { description: "d" });
  expect(update).toHaveBeenCalledWith({
    where: { id: "k40", organizationId: "o1", status: { in: ["open", "in_progress"] } },
    data: { description: "d" },
  });
  expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({ action: "tasks.ticket.mirror" }),
  );
  vi.mocked(recordAudit).mockClear();
  update.mockImplementation(async () => ({ count: 0 }));
  await mirrorTicketFieldsFromTask(tx, ctx, "k41", { description: "d" });
  expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
});
