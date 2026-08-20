import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Wrap the aliased @kason/db stub so getDb is a spy the tests can repoint. The
// real Prisma namespace stub (PrismaClientKnownRequestError) is preserved.
vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

// Partial mock of the repository: every function is mocked EXCEPT countSprintTasks,
// which the §1.10 no-tx read-path test must exercise for real (to catch an
// undefined-tx deref). withTransaction runs the callback against a fake tx whose
// sprint/task delegates are vi.fn()s the tests drive directly.
const fakeTx = {
  sprint: { updateMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
  task: { count: vi.fn(), updateMany: vi.fn() },
  // deleteSprintService takes a `SELECT … FOR UPDATE` row lock via tx.$queryRaw
  // before counting tasks (serializes a concurrent task-assignment's FK lock).
  $queryRaw: vi.fn(),
};

vi.mock("../sprints.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sprints.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(fakeTx)),
    findSprint: vi.fn(async () => null),
    findSprintInTx: vi.fn(async () => null),
    listSprints: vi.fn(async () => []),
    createSprintRow: vi.fn(),
    updateSprintGuarded: vi.fn(),
    nextSprintSeq: vi.fn(async () => 1),
    // Spec 3 derived-read repo fns (mocked — burndown/trends services drive them).
    listCompletedSprints: vi.fn(async () => []),
    countTasksInSprint: vi.fn(async () => 0),
    listDoneCompletions: vi.fn(async () => []),
    // countSprintTasks intentionally NOT mocked — uses the real impl (getDb()/tx).
  };
});

import { getDb } from "@kason/db";
import { recordAudit } from "../../../lib/audit";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import {
  countTasksInSprint,
  createSprintRow,
  findSprint,
  findSprintInTx,
  listCompletedSprints,
  listDoneCompletions,
  listSprints,
  nextSprintSeq,
  updateSprintGuarded,
  type DbSprint,
} from "../sprints.repository";
import {
  buildBurndown,
  buildSprintSummary,
  burndownService,
  closeSprintService,
  COMPLETED_NOT_DELETABLE,
  createSprintService,
  deleteSprintService,
  getSprintService,
  listSprintsService,
  startSprintService,
  trendsService,
  updateSprintService,
} from "../sprints.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const SPRINT = "00000000-0000-0000-0000-0000000000ee";
const ISO = "2026-06-01T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "manager" as const };

const STALE = "Record changed — reloaded";
const NOT_FOUND = "Sprint not found";
const NOT_PLANNED = "Only a planned sprint can be started";
const NOT_ACTIVE = "Only an active sprint can be closed";

function dbSprint(overrides: Partial<DbSprint> = {}): DbSprint {
  return {
    id: SPRINT,
    organizationId: ORG,
    seq: 1,
    name: null,
    goal: null,
    status: "planned",
    startsOn: null,
    endsOn: null,
    startedAt: null,
    completedAt: null,
    completedCount: null,
    carriedOverCount: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...overrides,
  } as DbSprint;
}

/** Data arg of the n-th updateSprintGuarded call — (tx, orgId, sprintId, updatedAt, data). */
function guardedData(call = 0): Record<string, unknown> {
  return vi.mocked(updateSprintGuarded).mock.calls[call]![4] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default getDb()/task.count → 0 so read paths a test doesn't stub still resolve.
  vi.mocked(getDb).mockReturnValue({ task: { count: vi.fn().mockResolvedValue(0) } } as never);
  vi.mocked(findSprint).mockResolvedValue(null);
  vi.mocked(findSprintInTx).mockResolvedValue(dbSprint());
  vi.mocked(listSprints).mockResolvedValue([]);
  vi.mocked(nextSprintSeq).mockResolvedValue(1);
  vi.mocked(createSprintRow).mockResolvedValue(dbSprint());
  vi.mocked(updateSprintGuarded).mockResolvedValue(dbSprint());
  vi.mocked(listCompletedSprints).mockResolvedValue([]);
  vi.mocked(countTasksInSprint).mockResolvedValue(0);
  vi.mocked(listDoneCompletions).mockResolvedValue([]);
  fakeTx.sprint.updateMany.mockReset().mockResolvedValue({ count: 1 });
  fakeTx.sprint.count.mockReset().mockResolvedValue(0);
  fakeTx.task.count.mockReset().mockResolvedValue(0);
  fakeTx.task.updateMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("buildSprintSummary (no-tx read path — §1.10)", () => {
  it("dereferences getDb().task.count for a live planned/active sprint without a tx", async () => {
    // This is the regression guard: countSprintTasks must use `tx ?? getDb()`.
    // We mock the @kason/db getDb() to expose task.count and assert the helper
    // actually called it (a `tx as TransactionClient` cast would NoOp/throw here).
    const count = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);

    const summary = await buildSprintSummary(ORG, dbSprint({ status: "active" }));

    expect(count).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ committed: 5, completed: 2, carried: 3, completionPct: 40 });
  });

  it("uses snapshot columns for a completed sprint (no DB read)", async () => {
    const count = vi.fn();
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);

    const summary = await buildSprintSummary(
      ORG,
      dbSprint({ status: "completed", completedCount: 7, carriedOverCount: 1 }),
    );

    expect(count).not.toHaveBeenCalled();
    expect(summary).toEqual({ committed: 8, completed: 7, carried: 1, completionPct: 88 });
  });

  it("completionPct is 0 when committed === 0", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    const summary = await buildSprintSummary(ORG, dbSprint({ status: "planned" }));
    expect(summary).toEqual({ committed: 0, completed: 0, carried: 0, completionPct: 0 });
  });
});

describe("listSprintsService", () => {
  it("maps rows to SprintRow with ISO-Z dates and null name/goal, passing the status filter", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(listSprints).mockResolvedValue([dbSprint({ seq: 3 })]);

    const result = await listSprintsService(ctx, { status: "planned" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listSprints).toHaveBeenCalledWith(ORG, { status: "planned" });
    const row = result.data[0]!;
    expect(row.seq).toBe(3);
    expect(row.name).toBeNull();
    expect(row.goal).toBeNull();
    expect(row.createdAt).toBe(ISO);
    expect(row.updatedAt).toBe(ISO);
    expect(row.summary).toEqual({ committed: 0, completed: 0, carried: 0, completionPct: 0 });
  });
});

describe("getSprintService", () => {
  it("returns 404 Sprint not found when missing/cross-org", async () => {
    vi.mocked(findSprint).mockResolvedValue(null);
    const result = await getSprintService(ctx, SPRINT);
    expect(result).toEqual({ ok: false, status: 404, error: NOT_FOUND });
  });

  it("returns 200 with the mapped row when found", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(findSprint).mockResolvedValue(dbSprint({ name: "Cycle 1", goal: "Ship it" }));
    const result = await getSprintService(ctx, SPRINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Cycle 1");
    expect(result.data.goal).toBe("Ship it");
  });
});

describe("createSprintService (§1.9)", () => {
  it("assigns the next seq, defaults endsOn to startsOn+14d, status=planned, audits create", async () => {
    vi.mocked(nextSprintSeq).mockResolvedValue(4);
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(createSprintRow).mockImplementation(
      async (_tx, data) => dbSprint({ ...(data as object) }) as DbSprint,
    );

    const result = await createSprintService(ctx, { startsOn: ISO });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(201);

    const createArg = vi.mocked(createSprintRow).mock.calls[0]![1] as Record<string, unknown>;
    expect(createArg).toMatchObject({
      organizationId: ORG,
      seq: 4,
      status: "planned",
      name: null,
    });
    // endsOn defaulted to startsOn + 14 days.
    expect((createArg.endsOn as Date).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect((createArg.startsOn as Date).toISOString()).toBe(ISO);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.sprint.create", entityType: "Sprint" }),
    );
  });

  it("leaves endsOn null when no startsOn given", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(createSprintRow).mockImplementation(
      async (_tx, data) => dbSprint({ ...(data as object) }) as DbSprint,
    );
    await createSprintService(ctx, { name: "Loose" });
    const createArg = vi.mocked(createSprintRow).mock.calls[0]![1] as Record<string, unknown>;
    expect(createArg.endsOn).toBeNull();
    expect(createArg.startsOn).toBeNull();
    expect(createArg.name).toBe("Loose");
  });

  it("honours an explicit endsOn over the +14d default", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(createSprintRow).mockImplementation(
      async (_tx, data) => dbSprint({ ...(data as object) }) as DbSprint,
    );
    await createSprintService(ctx, { startsOn: ISO, endsOn: "2026-06-20T00:00:00.000Z" });
    const createArg = vi.mocked(createSprintRow).mock.calls[0]![1] as Record<string, unknown>;
    expect((createArg.endsOn as Date).toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("maps a P2002 seq race to 409 stale", async () => {
    const { Prisma } = await import("@kason/db");
    vi.mocked(createSprintRow).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    const result = await createSprintService(ctx, {});
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("updateSprintService", () => {
  it("returns 404 when the sprint does not exist", async () => {
    vi.mocked(findSprint).mockResolvedValue(null);
    const result = await updateSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO, name: "X" });
    expect(result).toEqual({ ok: false, status: 404, error: NOT_FOUND });
  });

  it("writes only provided fields (updatedAt-guarded) and audits update", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(findSprint).mockResolvedValue(dbSprint());
    const result = await updateSprintService(ctx, {
      sprintId: SPRINT,
      updatedAt: ISO,
      name: "Renamed",
      goal: null,
    });
    expect(result.ok).toBe(true);
    expect(guardedData()).toEqual({ name: "Renamed", goal: null });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.sprint.update", entityType: "Sprint" }),
    );
  });

  it("coerces ISO startsOn/endsOn strings to Date in the guarded data", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(findSprint).mockResolvedValue(dbSprint());
    await updateSprintService(ctx, {
      sprintId: SPRINT,
      updatedAt: ISO,
      startsOn: ISO,
      endsOn: null,
    });
    const data = guardedData();
    expect((data.startsOn as Date).toISOString()).toBe(ISO);
    expect(data.endsOn).toBeNull();
  });

  it("maps StaleUpdateError to 409 stale", async () => {
    vi.mocked(findSprint).mockResolvedValue(dbSprint());
    vi.mocked(updateSprintGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await updateSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO, name: "X" });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("startSprintService (§1.8)", () => {
  it("returns 404 when the sprint does not exist", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(null);
    const result = await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: NOT_FOUND });
  });

  it("returns 400 NOT_PLANNED when the sprint is not planned", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(dbSprint({ status: "active" }));
    const result = await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 400, error: NOT_PLANNED });
  });

  it("starts a planned sprint even when another sprint is already active (multi-active)", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    // Another sprint is already active — the prior single-active guard is gone.
    fakeTx.sprint.count.mockResolvedValue(1);
    vi.mocked(findSprintInTx)
      .mockResolvedValueOnce(dbSprint({ status: "planned", startsOn: null }))
      .mockResolvedValue(dbSprint({ status: "active" }));
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 1 });

    const result = await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });

    expect(result.ok).toBe(true);
    expect(fakeTx.sprint.updateMany).toHaveBeenCalled();
    const data = fakeTx.sprint.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.status).toBe("active");
  });

  it("stamps active/startedAt and defaults startsOn to now, audits start", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    vi.mocked(findSprintInTx)
      .mockResolvedValueOnce(dbSprint({ status: "planned", startsOn: null }))
      .mockResolvedValue(dbSprint({ status: "active" }));
    fakeTx.sprint.count.mockResolvedValue(0);
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 1 });

    const result = await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result.ok).toBe(true);
    const data = fakeTx.sprint.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.status).toBe("active");
    expect(data.startedAt).toBeInstanceOf(Date);
    expect(data.startsOn).toBeInstanceOf(Date);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tasks.sprint.start", entityType: "Sprint" }),
    );
  });

  it("preserves an existing startsOn rather than defaulting to now", async () => {
    const count = vi.fn().mockResolvedValue(0);
    vi.mocked(getDb).mockReturnValue({ task: { count } } as never);
    const startsOn = new Date("2026-05-20T00:00:00.000Z");
    vi.mocked(findSprintInTx)
      .mockResolvedValueOnce(dbSprint({ status: "planned", startsOn }))
      .mockResolvedValue(dbSprint({ status: "active", startsOn }));
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 1 });
    await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    const data = fakeTx.sprint.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect((data.startsOn as Date).toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("maps a stale guarded update (count===0) to 409 stale", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(dbSprint({ status: "planned" }));
    fakeTx.sprint.count.mockResolvedValue(0);
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 0 });
    const result = await startSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("closeSprintService (§1.7 close ceremony)", () => {
  it("returns 404 when the sprint does not exist", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(null);
    const result = await closeSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 404, error: NOT_FOUND });
  });

  it("returns 400 NOT_ACTIVE when the sprint is not active", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(dbSprint({ status: "planned" }));
    const result = await closeSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 400, error: NOT_ACTIVE });
  });

  it("carries incomplete tasks to backlog (sprintId=null), retains done, snapshots counts, audits close", async () => {
    vi.mocked(findSprintInTx)
      .mockResolvedValueOnce(dbSprint({ status: "active" }))
      .mockResolvedValue(
        dbSprint({ status: "completed", completedCount: 5, carriedOverCount: 2 }),
      );
    // First count() = carried (status != done) = 2; second = completed (status=done) = 5.
    fakeTx.task.count.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 1 });

    const result = await closeSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result.ok).toBe(true);

    // Carry-forward updateMany: incomplete tasks → sprintId null.
    const carryCall = fakeTx.task.updateMany.mock.calls[0]![0];
    expect(carryCall.where).toMatchObject({
      organizationId: ORG,
      sprintId: SPRINT,
      status: { not: "done" },
    });
    expect(carryCall.data).toEqual({ sprintId: null });

    // Sprint snapshot update carries the counts.
    const sprintData = fakeTx.sprint.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(sprintData).toMatchObject({
      status: "completed",
      completedCount: 5,
      carriedOverCount: 2,
    });
    expect(sprintData.completedAt).toBeInstanceOf(Date);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tasks.sprint.close",
        entityType: "Sprint",
        meta: { completedCount: 5, carriedOverCount: 2 },
      }),
    );
  });

  it("maps a stale guarded sprint update (count===0) to 409 stale", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(dbSprint({ status: "active" }));
    fakeTx.task.count.mockResolvedValue(0);
    fakeTx.sprint.updateMany.mockResolvedValue({ count: 0 });
    const result = await closeSprintService(ctx, { sprintId: SPRINT, updatedAt: ISO });
    expect(result).toEqual({ ok: false, status: 409, error: STALE });
  });
});

describe("deleteSprintService", () => {
  const ctx = { orgId: "o1", actorUserId: "u1", actorRole: "manager" as const };
  const input = { sprintId: "s1", updatedAt: "2026-06-10T00:00:00.000Z" };
  const base: DbSprint = {
    id: "s1",
    organizationId: "o1",
    seq: 1,
    name: null,
    goal: null,
    status: "planned",
    startsOn: null,
    endsOn: null,
    startedAt: null,
    completedAt: null,
    completedCount: null,
    carriedOverCount: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
  };

  beforeEach(() => {
    fakeTx.sprint.deleteMany.mockReset();
    fakeTx.task.count.mockReset();
    fakeTx.$queryRaw.mockReset();
  });

  it("404 when the sprint is missing", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(null);
    const res = await deleteSprintService(ctx, input);
    expect(res).toEqual({ ok: false, status: 404, error: "Sprint not found" });
    expect(fakeTx.sprint.deleteMany).not.toHaveBeenCalled();
  });

  it("400 when the sprint is completed", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue({ ...base, status: "completed" });
    const res = await deleteSprintService(ctx, input);
    expect(res).toEqual({ ok: false, status: 400, error: COMPLETED_NOT_DELETABLE });
    expect(fakeTx.sprint.deleteMany).not.toHaveBeenCalled();
  });

  it("409 with a task-count message when tasks are still assigned (no delete)", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(base);
    fakeTx.task.count.mockResolvedValue(3);
    const res = await deleteSprintService(ctx, input);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect((res as { error: string }).error).toContain("3 tasks");
    // Lock acquired before the count; count is org-scoped.
    expect(fakeTx.$queryRaw).toHaveBeenCalled();
    expect(fakeTx.task.count).toHaveBeenCalledWith({
      where: { organizationId: "o1", sprintId: "s1" },
    });
    expect(fakeTx.sprint.deleteMany).not.toHaveBeenCalled();
  });

  it("200 deletes an empty sprint and records a tasks.sprint.delete audit row", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(base);
    fakeTx.task.count.mockResolvedValue(0);
    fakeTx.sprint.deleteMany.mockResolvedValue({ count: 1 });
    const res = await deleteSprintService(ctx, input);
    expect(res).toEqual({ ok: true, status: 200, data: { id: "s1" } });
    // Row lock issued before the (org-scoped) count, then the guarded delete.
    expect(fakeTx.$queryRaw).toHaveBeenCalled();
    expect(fakeTx.task.count).toHaveBeenCalledWith({
      where: { organizationId: "o1", sprintId: "s1" },
    });
    expect(fakeTx.sprint.deleteMany).toHaveBeenCalledWith({
      where: { id: "s1", organizationId: "o1", updatedAt: new Date(input.updatedAt) },
    });
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      fakeTx,
      expect.objectContaining({
        action: "tasks.sprint.delete",
        entityType: "Sprint",
        entityId: "s1",
      }),
    );
  });

  it("409 stale when updatedAt no longer matches (deleteMany count 0)", async () => {
    vi.mocked(findSprintInTx).mockResolvedValue(base);
    fakeTx.task.count.mockResolvedValue(0);
    fakeTx.sprint.deleteMany.mockResolvedValue({ count: 0 });
    const res = await deleteSprintService(ctx, input);
    expect(res).toEqual({ ok: false, status: 409, error: "Record changed — reloaded" });
  });
});

// ─── Spec 3: cross-sprint trends (§5/§7/§8) ─────────────────────────────────────

describe("trendsService (Spec 3 §5)", () => {
  it("maps completed-sprint snapshots to trend points ordered seq ASC", async () => {
    // repo returns seq DESC (most-recent-first); service must reverse to ASC.
    vi.mocked(listCompletedSprints).mockResolvedValue([
      dbSprint({ seq: 3, name: "Cycle 3", status: "completed", completedCount: 9, carriedOverCount: 1 }),
      dbSprint({ seq: 2, name: null, status: "completed", completedCount: 4, carriedOverCount: 4 }),
      dbSprint({ seq: 1, name: "Cycle 1", status: "completed", completedCount: 6, carriedOverCount: 2 }),
    ]);
    const result = await trendsService(ctx, { window: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(result.data[0]).toEqual({
      seq: 1,
      name: "Cycle 1",
      completed: 6,
      carried: 2,
      completionRate: 75, // 6/8
    });
    expect(result.data[1]).toEqual({
      seq: 2,
      name: null,
      completed: 4,
      carried: 4,
      completionRate: 50, // 4/8
    });
    expect(result.data[2]!.completionRate).toBe(90); // 9/10
  });

  it("defaults the window to 8 when none supplied", async () => {
    await trendsService(ctx, {});
    expect(listCompletedSprints).toHaveBeenCalledWith(ORG, 8);
  });

  it("passes an explicit window straight to the repo (limit)", async () => {
    await trendsService(ctx, { window: 3 });
    expect(listCompletedSprints).toHaveBeenCalledWith(ORG, 3);
  });

  it("completionRate is 0 for a zero-committed sprint (no divide-by-zero)", async () => {
    vi.mocked(listCompletedSprints).mockResolvedValue([
      dbSprint({ seq: 1, status: "completed", completedCount: 0, carriedOverCount: 0 }),
    ]);
    const result = await trendsService(ctx, {});
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ completed: 0, carried: 0, completionRate: 0 });
  });

  it("treats null snapshot columns as 0", async () => {
    vi.mocked(listCompletedSprints).mockResolvedValue([
      dbSprint({ seq: 1, status: "completed", completedCount: null, carriedOverCount: null }),
    ]);
    const result = await trendsService(ctx, {});
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ completed: 0, carried: 0, completionRate: 0 });
  });
});

// ─── Spec 3: within-sprint burndown — pure derivation (§4) ──────────────────────

describe("buildBurndown (Spec 3 §4 — pure, injectable now)", () => {
  const START = new Date("2026-06-01T00:00:00.000Z");
  const END = new Date("2026-06-05T00:00:00.000Z"); // 5 UTC days: Jun 1..5
  // Two completions: Jun 2 and Jun 4 (mid-day, well inside their UTC day).
  const COMPLETIONS = [
    new Date("2026-06-02T10:00:00.000Z"),
    new Date("2026-06-04T10:00:00.000Z"),
  ];

  it("ideal is linear scope→0 across the window, one point per UTC day", () => {
    const b = buildBurndown({
      scope: 4,
      startsOn: START,
      endsOn: END,
      status: "active",
      completions: [],
      now: END, // active but now ≥ end → full window plotted
    });
    expect(b.ideal.map((p) => p.date)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
    expect(b.ideal.map((p) => p.remaining)).toEqual([4, 3, 2, 1, 0]);
  });

  it("actual steps down exactly at each completedAt (completed sprint, full window)", () => {
    const b = buildBurndown({
      scope: 4,
      startsOn: START,
      endsOn: END,
      status: "completed",
      completions: COMPLETIONS,
    });
    // Jun1→4, Jun2→3 (1 done), Jun3→3, Jun4→2 (2 done), Jun5→2.
    expect(b.actual.map((p) => p.remaining)).toEqual([4, 3, 3, 2, 2]);
  });

  it("a completed sprint with leftovers terminates at carriedOverCount, not 0", () => {
    // scope = completed(2) + carried(2) = 4; only 2 ever completed → ends at 2.
    const b = buildBurndown({
      scope: 4,
      startsOn: START,
      endsOn: END,
      status: "completed",
      completions: COMPLETIONS,
    });
    expect(b.actual[b.actual.length - 1]!.remaining).toBe(2);
    expect(b.actual[b.actual.length - 1]!.remaining).not.toBe(0);
  });

  it("an active sprint stops plotting actual at the injected `now` (no projection)", () => {
    const b = buildBurndown({
      scope: 4,
      startsOn: START,
      endsOn: END,
      status: "active",
      completions: COMPLETIONS,
      now: new Date("2026-06-03T12:00:00.000Z"), // mid-sprint
    });
    // actual only Jun1,2,3 — ideal still spans the whole window.
    expect(b.actual.map((p) => p.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(b.actual.map((p) => p.remaining)).toEqual([4, 3, 3]);
    expect(b.ideal).toHaveLength(5);
  });

  it("returns empty actual when `now` precedes the sprint start (active)", () => {
    const b = buildBurndown({
      scope: 4,
      startsOn: START,
      endsOn: END,
      status: "active",
      completions: COMPLETIONS,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    expect(b.actual).toEqual([]);
    expect(b.ideal).toHaveLength(5);
  });

  it("a single-day window yields one ideal point at scope (degenerate, documented)", () => {
    const b = buildBurndown({
      scope: 3,
      startsOn: START,
      endsOn: START,
      status: "completed",
      completions: [],
    });
    expect(b.ideal).toEqual([{ date: "2026-06-01", remaining: 3 }]);
    expect(b.actual).toEqual([{ date: "2026-06-01", remaining: 3 }]);
  });

  it("returns bare scope with empty series when the sprint was never dated (§4 null window)", () => {
    const b = buildBurndown({
      scope: 5,
      startsOn: null,
      endsOn: null,
      status: "active",
      completions: [],
    });
    expect(b).toEqual({ scope: 5, ideal: [], actual: [] });
  });
});

// ─── Spec 3: burndownService — scope source + wiring (§4/§7) ─────────────────────

describe("burndownService (Spec 3 §4/§7)", () => {
  it("returns 404 when the sprint is missing/cross-org", async () => {
    vi.mocked(findSprint).mockResolvedValue(null);
    const result = await burndownService(ctx, SPRINT);
    expect(result).toEqual({ ok: false, status: 404, error: NOT_FOUND });
  });

  it("active sprint: scope = live task count (countTasksInSprint), not the snapshot", async () => {
    vi.mocked(findSprint).mockResolvedValue(
      dbSprint({
        status: "active",
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        endsOn: new Date("2026-06-05T00:00:00.000Z"),
        completedCount: 999, // snapshot must be IGNORED for an active sprint
        carriedOverCount: 999,
      }),
    );
    vi.mocked(countTasksInSprint).mockResolvedValue(7);
    vi.mocked(listDoneCompletions).mockResolvedValue([]);
    const result = await burndownService(ctx, SPRINT, new Date("2026-06-05T00:00:00.000Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countTasksInSprint).toHaveBeenCalledWith(ORG, SPRINT);
    expect(result.data.scope).toBe(7);
    expect(result.data.ideal[0]!.remaining).toBe(7);
  });

  it("completed sprint: scope = completedCount + carriedOverCount (snapshot), no live count", async () => {
    vi.mocked(findSprint).mockResolvedValue(
      dbSprint({
        status: "completed",
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        endsOn: new Date("2026-06-05T00:00:00.000Z"),
        completedCount: 5,
        carriedOverCount: 3,
      }),
    );
    vi.mocked(listDoneCompletions).mockResolvedValue([
      new Date("2026-06-02T10:00:00.000Z"),
    ]);
    const result = await burndownService(ctx, SPRINT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countTasksInSprint).not.toHaveBeenCalled();
    expect(result.data.scope).toBe(8); // 5 + 3
    // 1 completion → last actual remaining = 8 - 1 = 7.
    expect(result.data.actual[result.data.actual.length - 1]!.remaining).toBe(7);
  });
});
