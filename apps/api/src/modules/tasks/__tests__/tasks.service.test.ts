import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

const mockTx = {
  task: {
    updateMany: vi.fn(async () => ({ count: 1 })),
    findFirst: vi.fn(async () => ({ updatedAt: new Date("2026-06-01T00:00:00.000Z") }) as unknown),
  },
  ticket: {
    findFirst: vi.fn(async () => null as unknown),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
};

vi.mock("../tasks.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx)),
  listTasks: vi.fn(async () => []),
  findTask: vi.fn(async () => null),
  findTaskInTx: vi.fn(async () => null),
  createTaskRow: vi.fn(),
  updateTaskGuarded: vi.fn(),
  renumberLane: vi.fn(async () => undefined),
  nextLaneSortOrder: vi.fn(async () => 0),
  findActiveOperator: vi.fn(async () => null),
  getUsersByIds: vi.fn(async () => []),
  findListing: vi.fn(async () => null),
  findTicketById: vi.fn(async () => null),
}));

vi.mock("../sprints.repository", () => ({
  findSprint: vi.fn(async () => null),
}));

vi.mock("../mirror", () => ({
  spawnTicketForTask: vi.fn(async () => "new-ticket"),
  mirrorTicketFromTask: vi.fn(async () => undefined),
  mirrorTicketFieldsFromTask: vi.fn(async () => undefined),
  reopenTicketFromTask: vi.fn(async () => undefined),
}));

import { recordAudit } from "../../../lib/audit";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import {
  createTaskRow,
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
  type DbTask,
} from "../tasks.repository";
import { findSprint } from "../sprints.repository";
import {
  mirrorTicketFieldsFromTask,
  mirrorTicketFromTask,
  reopenTicketFromTask,
  spawnTicketForTask,
} from "../mirror";
import {
  archiveTaskService,
  assignTaskService,
  createTaskService,
  listTasksService,
  moveTaskService,
  restoreTaskService,
  updateTaskService,
} from "../tasks.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const ASSIGNEE = "00000000-0000-0000-0000-0000000000aa";
const TASK = "00000000-0000-0000-0000-0000000000bb";
const UNIT = "00000000-0000-0000-0000-0000000000cc";
const TICKET = "00000000-0000-0000-0000-0000000000dd";
const SPRINT = "00000000-0000-0000-0000-0000000000ee";
const ISO = "2026-06-01T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "manager" as const };

const STALE = "Record changed — reloaded";
const ARCHIVED = "Task is archived — restore it first";

function dbTask(overrides: Partial<DbTask> = {}): DbTask {
  return {
    id: TASK,
    organizationId: ORG,
    title: "Fix kitchen light",
    description: null,
    status: "todo",
    priority: "medium",
    category: null,
    sortOrder: 0,
    attachmentKeys: [],
    assigneeUserId: null,
    relatedUnitId: null,
    ticketId: null,
    sprintId: null,
    createdBy: ACTOR,
    dueOn: null,
    startedAt: null,
    completedAt: null,
    assignedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    relatedUnit: null,
    ...overrides,
  } as DbTask;
}

/** Data arg of the n-th updateTaskGuarded call — (tx, orgId, taskId, updatedAt, data). */
function guardedData(call = 0): Record<string, unknown> {
  return vi.mocked(updateTaskGuarded).mock.calls[call]![4] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findTask).mockResolvedValue(null);
  vi.mocked(findTaskInTx).mockResolvedValue(dbTask());
  vi.mocked(findListing).mockResolvedValue(null);
  vi.mocked(findTicketById).mockResolvedValue(null);
  vi.mocked(findSprint).mockResolvedValue(null);
  vi.mocked(findActiveOperator).mockResolvedValue(null);
  vi.mocked(nextLaneSortOrder).mockResolvedValue(0);
  vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask());
  vi.mocked(listTasks).mockResolvedValue([]);
  vi.mocked(getUsersByIds).mockResolvedValue([]);
  mockTx.task.updateMany.mockResolvedValue({ count: 1 });
  mockTx.task.findFirst.mockResolvedValue({ updatedAt: new Date(ISO) });
  mockTx.ticket.findFirst.mockResolvedValue(null);
  mockTx.ticket.updateMany.mockResolvedValue({ count: 1 });
});

describe("listTasksService", () => {
  it("maps DbTask → TaskRow: flattened relatedUnit, resolved assignee, ISO dates", async () => {
    vi.mocked(listTasks).mockResolvedValue([
      dbTask({
        assigneeUserId: ASSIGNEE,
        relatedUnitId: UNIT,
        relatedUnit: {
          id: UNIT,
          apartment: { unitCode: "A-12-03", property: { name: "Casa Green" } },
        },
        dueOn: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]);
    vi.mocked(getUsersByIds).mockResolvedValue([{ id: ASSIGNEE, fullName: "Ops One", photoKey: null }]);

    const result = await listTasksService(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    const row = result.data[0]!;
    expect(row.relatedUnit).toEqual({ id: UNIT, unitCode: "A-12-03", propertyName: "Casa Green" });
    expect(row.assignee).toEqual({ id: ASSIGNEE, fullName: "Ops One", photoUrl: null });
    expect(row.dueOn).toBe("2026-07-01T00:00:00.000Z");
    expect(row.createdAt).toBe(ISO);
    expect(row.updatedAt).toBe(ISO);
    expect(getUsersByIds).toHaveBeenCalledWith(ORG, [ASSIGNEE]);
  });
});

describe("createTaskService", () => {
  it("defaults to the pool lane when no assignee is given", async () => {
    vi.mocked(createTaskRow).mockResolvedValue(dbTask({ status: "pool" }));
    const result = await createTaskService(ctx, { title: "T", priority: "medium" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(201);
    expect(createTaskRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "pool", assigneeUserId: null, createdBy: ACTOR }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.create", entityType: "Task" }),
    );
  });

  it("starts in todo when an active operator assignee is given", async () => {
    vi.mocked(findActiveOperator).mockResolvedValue({ id: ASSIGNEE, fullName: "Ops One" });
    vi.mocked(createTaskRow).mockResolvedValue(
      dbTask({ status: "todo", assigneeUserId: ASSIGNEE }),
    );
    const result = await createTaskService(ctx, {
      title: "T",
      priority: "medium",
      assigneeUserId: ASSIGNEE,
    });
    expect(result.ok).toBe(true);
    expect(createTaskRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "todo", assigneeUserId: ASSIGNEE }),
    );
  });

  it("rejects an assignee who is not an active operator (400)", async () => {
    const result = await createTaskService(ctx, {
      title: "T",
      priority: "medium",
      assigneeUserId: ASSIGNEE,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Assignee must be an active admin user",
    });
    expect(createTaskRow).not.toHaveBeenCalled();
  });

  it("returns 404 Unit not found for an unknown relatedUnitId", async () => {
    const result = await createTaskService(ctx, {
      title: "T",
      priority: "medium",
      relatedUnitId: UNIT,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
  });

  it("returns 404 Ticket not found for an unknown ticketId", async () => {
    const result = await createTaskService(ctx, {
      title: "T",
      priority: "medium",
      ticketId: TICKET,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Ticket not found" });
  });

  it("spawn-from-ticket inherits the ticket's unit when relatedUnitId is omitted", async () => {
    vi.mocked(findTicketById).mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    vi.mocked(createTaskRow).mockResolvedValue(
      dbTask({ status: "pool", ticketId: TICKET, relatedUnitId: UNIT }),
    );
    const result = await createTaskService(ctx, {
      title: "T",
      priority: "medium",
      ticketId: TICKET,
    });
    expect(result.ok).toBe(true);
    expect(createTaskRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ relatedUnitId: UNIT, ticketId: TICKET }),
    );
  });
});

describe("updateTaskService", () => {
  it("returns 404 when the task does not exist", async () => {
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 404, error: "Task not found" });
  });

  it("returns 409 with the exact archived message for an archived task", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived" }));
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: ARCHIVED });
  });

  it("returns 404 Unit not found for an unknown relatedUnitId", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    const result = await updateTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      relatedUnitId: UNIT,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Unit not found" });
  });

  it("only writes the provided fields and audits tasks.task.update", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    const result = await updateTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      title: "New title",
    });
    expect(result.ok).toBe(true);
    const data = guardedData();
    expect(data).toEqual({ title: "New title" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.update" }),
    );
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    vi.mocked(updateTaskGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, title: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("moveTaskService", () => {
  it("returns 404 when the task does not exist", async () => {
    const result = await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "todo" });
    expect(result).toEqual({ ok: false, status: 404, error: "Task not found" });
  });

  it("returns 409 with the exact archived message for an archived task", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived" }));
    const result = await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "todo" });
    expect(result).toEqual({ ok: false, status: 409, error: ARCHIVED });
  });

  it("moving to pool clears the assignee", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo", assigneeUserId: ASSIGNEE }));
    const result = await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "pool" });
    expect(result.ok).toBe(true);
    expect(guardedData()).toMatchObject({ status: "pool", assigneeUserId: null });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.move" }),
    );
  });

  it("first move to in_progress stamps startedAt", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo", startedAt: null }));
    await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "in_progress" });
    expect(guardedData().startedAt).toBeInstanceOf(Date);
  });

  it("second move to in_progress does NOT overwrite startedAt", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ status: "done", startedAt: new Date("2026-05-01T00:00:00.000Z") }),
    );
    await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "in_progress" });
    expect(guardedData()).not.toHaveProperty("startedAt");
  });

  it("moving to done stamps completedAt", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "in_progress" }));
    await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "done" });
    expect(guardedData().completedAt).toBeInstanceOf(Date);
  });

  it("moving out of done clears completedAt", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ status: "done", completedAt: new Date("2026-05-02T00:00:00.000Z") }),
    );
    await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "todo" });
    expect(guardedData().completedAt).toBeNull();
  });

  it("appends to the target lane when no position is given (no renumber)", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo" }));
    vi.mocked(nextLaneSortOrder).mockResolvedValue(5);
    await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "in_progress" });
    expect(guardedData().sortOrder).toBe(5);
    expect(renumberLane).not.toHaveBeenCalled();
  });

  it("renumbers the lane when a position is given and audits/returns the post-renumber sortOrder", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo", sortOrder: 0 }));
    // updateTaskGuarded sees the pre-renumber row; the in-tx re-read sees the final one.
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ status: "in_progress", sortOrder: 0 }));
    vi.mocked(findTaskInTx).mockResolvedValue(dbTask({ status: "in_progress", sortOrder: 2 }));
    const result = await moveTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      status: "in_progress",
      position: 2,
    });
    expect(guardedData()).not.toHaveProperty("sortOrder");
    expect(renumberLane).toHaveBeenCalledWith(expect.anything(), ORG, "in_progress", TASK, 2);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.task.move",
        diff: expect.objectContaining({
          after: expect.objectContaining({ sortOrder: 2, position: 2 }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sortOrder).toBe(2);
  });

  it("done→done reorder does NOT re-stamp completedAt", async () => {
    const completedAt = new Date("2026-05-02T00:00:00.000Z");
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "done", completedAt }));
    const result = await moveTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      status: "done",
      position: 1,
    });
    expect(result.ok).toBe(true);
    expect(guardedData()).not.toHaveProperty("completedAt");
    expect(renumberLane).toHaveBeenCalledWith(expect.anything(), ORG, "done", TASK, 1);
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    vi.mocked(updateTaskGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await moveTaskService(ctx, { taskId: TASK, updatedAt: ISO, status: "done" });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("assignTaskService", () => {
  it("returns 404 when the task does not exist", async () => {
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: ASSIGNEE,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Task not found" });
  });

  it("returns 409 with the exact archived message for an archived task", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived" }));
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: ASSIGNEE,
    });
    expect(result).toEqual({ ok: false, status: 409, error: ARCHIVED });
  });

  it("refuses to unassign a done task with the exact 409 message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "done", assigneeUserId: ASSIGNEE }));
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: null,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Completed tasks keep their assignee — move it out of done first",
    });
  });

  it("rejects an assignee who is not an active operator (400)", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo" }));
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: ASSIGNEE,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Assignee must be an active admin user",
    });
  });

  it("assigning a pool task promotes it to todo and audits tasks.task.assign", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "pool" }));
    vi.mocked(findActiveOperator).mockResolvedValue({ id: ASSIGNEE, fullName: "Ops One" });
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: ASSIGNEE,
    });
    expect(result.ok).toBe(true);
    expect(guardedData()).toMatchObject({ status: "todo", assigneeUserId: ASSIGNEE });
    expect(guardedData().assignedAt).toBeInstanceOf(Date);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.task.assign",
        meta: { from: null, to: ASSIGNEE },
      }),
    );
  });

  it("unassigning an in_progress task demotes it to pool", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ status: "in_progress", assigneeUserId: ASSIGNEE }),
    );
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: null,
    });
    expect(result.ok).toBe(true);
    expect(guardedData()).toMatchObject({ status: "pool", assigneeUserId: null });
    expect(guardedData().assignedAt).toBeNull();
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "pool" }));
    vi.mocked(findActiveOperator).mockResolvedValue({ id: ASSIGNEE, fullName: "Ops One" });
    vi.mocked(updateTaskGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await assignTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      assigneeUserId: ASSIGNEE,
    });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("archiveTaskService", () => {
  it("returns 404 when the task does not exist", async () => {
    const result = await archiveTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: "Task not found" });
  });

  it("returns 409 when the task is already archived", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived" }));
    const result = await archiveTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: "Task is already archived" });
  });

  it("archives and audits tasks.task.archive with the fromStatus", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "in_progress" }));
    const result = await archiveTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ status: "archived" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.task.archive",
        meta: { fromStatus: "in_progress" },
      }),
    );
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo" }));
    vi.mocked(updateTaskGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await archiveTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("restoreTaskService", () => {
  it("returns 404 when the task does not exist", async () => {
    const result = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: "Task not found" });
  });

  it("returns 409 when the task is not archived", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "todo" }));
    const result = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: "Task is not archived" });
  });

  it("restores an archived task WITH an assignee to todo and audits tasks.task.restore", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ status: "archived", assigneeUserId: ASSIGNEE }),
    );
    vi.mocked(nextLaneSortOrder).mockResolvedValue(3);
    const result = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ status: "todo", sortOrder: 3 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.task.restore", meta: { toStatus: "todo" } }),
    );
  });

  it("restores an archived unassigned task to pool", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived", assigneeUserId: null }));
    const result = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result.ok).toBe(true);
    expect(guardedData()).toMatchObject({ status: "pool" });
  });

  it("maps StaleUpdateError to a 409 with the exact stale message", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ status: "archived" }));
    vi.mocked(updateTaskGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("sprintId membership (write-path §1.6)", () => {
  it("createTaskService passes a provided sprintId into the create row", async () => {
    vi.mocked(findSprint).mockResolvedValue({ id: SPRINT } as never);
    vi.mocked(createTaskRow).mockResolvedValue(dbTask({ sprintId: SPRINT }));
    const result = await createTaskService(ctx, { title: "T", priority: "medium", sprintId: SPRINT });
    expect(result.ok).toBe(true);
    expect(createTaskRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sprintId: SPRINT }),
    );
  });

  it("createTaskService returns 404 Sprint not found for an unknown sprintId", async () => {
    vi.mocked(findSprint).mockResolvedValue(null);
    const result = await createTaskService(ctx, { title: "T", priority: "medium", sprintId: SPRINT });
    expect(result).toEqual({ ok: false, status: 404, error: "Sprint not found" });
    expect(createTaskRow).not.toHaveBeenCalled();
  });

  it("createTaskService defaults sprintId to null (Backlog) when omitted", async () => {
    vi.mocked(createTaskRow).mockResolvedValue(dbTask({ status: "pool" }));
    await createTaskService(ctx, { title: "T", priority: "medium" });
    expect(createTaskRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sprintId: null }),
    );
    expect(findSprint).not.toHaveBeenCalled();
  });

  it("updateTaskService writes a provided sprintId into the guarded update", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    vi.mocked(findSprint).mockResolvedValue({ id: SPRINT } as never);
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, sprintId: SPRINT });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ sprintId: SPRINT });
  });

  it("updateTaskService moves a task to Backlog when sprintId is null (no existence check)", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ sprintId: SPRINT }));
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, sprintId: null });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ sprintId: null });
    expect(findSprint).not.toHaveBeenCalled();
  });

  it("updateTaskService returns 404 Sprint not found for an unknown sprintId", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask());
    vi.mocked(findSprint).mockResolvedValue(null);
    const result = await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, sprintId: SPRINT });
    expect(result).toEqual({ ok: false, status: 404, error: "Sprint not found" });
  });

  it("listTasksService forwards the sprintId filter to the repository", async () => {
    await listTasksService(ctx, { sprintId: "null" });
    expect(listTasks).toHaveBeenCalledWith(ORG, { sprintId: "null" });
  });

  it("mapTask surfaces sprintId on the row", async () => {
    vi.mocked(listTasks).mockResolvedValue([dbTask({ sprintId: SPRINT })]);
    const result = await listTasksService(ctx, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]!.sprintId).toBe(SPRINT);
  });
});

// ─── Task 1.5: Reverse spawn — createTaskService + updateTaskService ──────────

describe("Task 1.5 — reverse spawn (task → ticket)", () => {
  it("create with a unit and no ticketId spawns a ticket and links it", async () => {
    vi.mocked(findListing).mockResolvedValue({ id: UNIT } as never);
    vi.mocked(createTaskRow).mockResolvedValue(
      dbTask({ status: "pool", relatedUnitId: UNIT, ticketId: null }),
    );
    await createTaskService(ctx, { title: "Fix gate", priority: "medium", relatedUnitId: UNIT });
    expect(vi.mocked(spawnTicketForTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnTicketForTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: TASK, relatedUnitId: UNIT }),
    );
  });

  it("create spawned FROM a ticket (ticketId set) does NOT create another ticket", async () => {
    vi.mocked(findTicketById).mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    vi.mocked(createTaskRow).mockResolvedValue(
      dbTask({ status: "pool", ticketId: TICKET, relatedUnitId: UNIT }),
    );
    await createTaskService(ctx, { title: "AC", priority: "medium", ticketId: TICKET });
    expect(vi.mocked(spawnTicketForTask)).not.toHaveBeenCalled();
  });

  it("update that sets a unit on a ticketless task spawns a ticket", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: null, relatedUnitId: null }));
    vi.mocked(findListing).mockResolvedValue({ id: UNIT } as never);
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ relatedUnitId: UNIT, ticketId: null }),
    );
    await updateTaskService(ctx, { taskId: TASK, relatedUnitId: UNIT, updatedAt: ISO });
    expect(vi.mocked(spawnTicketForTask)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnTicketForTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: TASK, relatedUnitId: UNIT }),
    );
  });

  it("update on a task that already has a ticketId does NOT double-spawn", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: TICKET, relatedUnitId: UNIT }));
    vi.mocked(findListing).mockResolvedValue({ id: UNIT } as never);
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ relatedUnitId: UNIT, ticketId: TICKET }),
    );
    await updateTaskService(ctx, { taskId: TASK, relatedUnitId: UNIT, updatedAt: ISO });
    expect(vi.mocked(spawnTicketForTask)).not.toHaveBeenCalled();
  });
});

// ─── Task 1.6: Task close mirror + reopen guard ───────────────────────────────

describe("Task 1.6 — task close mirror + reopen guard", () => {
  it("moving a linked task to done resolves its ticket", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "in_progress" }),
    );
    vi.mocked(findTicketById).mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "done" }),
    );
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    await moveTaskService(ctx, { taskId: TASK, status: "done", updatedAt: ISO });
    expect(vi.mocked(mirrorTicketFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      { id: TICKET, unitId: UNIT, status: "open" },
      "resolved",
    );
  });

  it("moving a linked task to in_progress mirrors ticket to in_progress", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "todo" }),
    );
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "in_progress" }),
    );
    await moveTaskService(ctx, { taskId: TASK, status: "in_progress", updatedAt: ISO });
    expect(vi.mocked(mirrorTicketFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      { id: TICKET, unitId: UNIT, status: "open" },
      "in_progress",
    );
  });

  it("moving a linked task OUT of done succeeds and reopens the resolved ticket", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "done", completedAt: new Date(ISO) }),
    );
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, unitId: UNIT, status: "resolved" });
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "in_progress" }),
    );
    const res = await moveTaskService(ctx, { taskId: TASK, status: "in_progress", updatedAt: ISO });
    expect(res).toMatchObject({ ok: true });
    expect(guardedData().completedAt).toBeNull();
    expect(vi.mocked(reopenTicketFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      { id: TICKET, unitId: UNIT, status: "resolved" },
      "in_progress",
    );
    // The forward mirror must NOT fire on a pull-back.
    expect(vi.mocked(mirrorTicketFromTask)).not.toHaveBeenCalled();
  });

  it("pull-back to todo hands the lane to the reopen mirror (todo → ticket open)", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "done", completedAt: new Date(ISO) }),
    );
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, unitId: UNIT, status: "resolved" });
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: TICKET, status: "todo" }));
    const res = await moveTaskService(ctx, { taskId: TASK, status: "todo", updatedAt: ISO });
    expect(res).toMatchObject({ ok: true });
    expect(vi.mocked(reopenTicketFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({ id: TICKET }),
      "todo",
    );
  });

  it("moving an unlinked task out of done is allowed (no ticketId guard)", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: null, status: "done", completedAt: new Date(ISO) }),
    );
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: null, status: "todo" }));
    const res = await moveTaskService(ctx, { taskId: TASK, status: "todo", updatedAt: ISO });
    expect(res).toMatchObject({ ok: true });
  });

  it("archiving a linked task voids its ticket", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "todo" }),
    );
    mockTx.ticket.findFirst.mockResolvedValue({ id: TICKET, unitId: UNIT, status: "open" });
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ ticketId: TICKET, status: "archived" }),
    );
    await archiveTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(vi.mocked(mirrorTicketFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      { id: TICKET, unitId: UNIT, status: "open" },
      "void",
    );
  });

  it("restoring a task whose ticket was voided reopens the ticket (void → open) and audits it", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: TICKET, status: "archived" }));
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: TICKET, status: "pool" }));
    // findTicketInTx reads through mockTx.ticket.findFirst → return a void ticket.
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET, organizationId: ORG, status: "void", updatedAt: new Date(ISO),
    });
    const res = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(res.ok).toBe(true);
    // Ticket flipped to open via the guarded update.
    expect(mockTx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "open" }) }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.ticket.reopen" }),
    );
  });

  it("restoring a linked task whose ticket is NOT void leaves the ticket untouched", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: TICKET, status: "archived" }));
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: TICKET, status: "pool" }));
    mockTx.ticket.findFirst.mockResolvedValue({
      id: TICKET, organizationId: ORG, status: "open", updatedAt: new Date(ISO),
    });
    const res = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(res.ok).toBe(true);
    expect(mockTx.ticket.updateMany).not.toHaveBeenCalled();
  });

  it("restoring an unlinked archived task is allowed", async () => {
    vi.mocked(findTask).mockResolvedValue(
      dbTask({ ticketId: null, status: "archived" }),
    );
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: null, status: "pool" }));
    const res = await restoreTaskService(ctx, { taskId: TASK, updatedAt: ISO });
    expect(res).toMatchObject({ ok: true });
  });
});

// ─── Punch list #5: task field edits mirror to the paired ticket ──────────────

describe("updateTaskService — shared-field mirror", () => {
  it("mirrors title/description/category edits to the linked ticket", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: TICKET }));
    vi.mocked(updateTaskGuarded).mockResolvedValue(
      dbTask({ ticketId: TICKET, category: "Plumbing" }),
    );
    const res = await updateTaskService(ctx, {
      taskId: TASK,
      updatedAt: ISO,
      category: "Plumbing",
      priority: "high",
    });
    expect(res).toMatchObject({ ok: true });
    // priority is task-private — only the shared field crosses the mirror.
    expect(vi.mocked(mirrorTicketFieldsFromTask)).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      TICKET,
      { category: "Plumbing" },
    );
  });

  it("does not call the field mirror for an unlinked task", async () => {
    vi.mocked(findTask).mockResolvedValue(dbTask({ ticketId: null }));
    vi.mocked(updateTaskGuarded).mockResolvedValue(dbTask({ ticketId: null, title: "New" }));
    await updateTaskService(ctx, { taskId: TASK, updatedAt: ISO, title: "New" });
    expect(vi.mocked(mirrorTicketFieldsFromTask)).not.toHaveBeenCalled();
  });
});
