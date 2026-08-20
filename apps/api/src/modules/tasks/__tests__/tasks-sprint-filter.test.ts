import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the REAL listTasks against a mocked getDb so we can assert the
// WHERE it builds without a database (the DB-backed integration suite is
// deferred). Covers the additive sprintId filter (§1.6).
const findMany = vi.fn(async (_query?: { where: Record<string, unknown> }) => [] as unknown[]);
vi.mock("@kason/db", () => ({ getDb: () => ({ task: { findMany } }) }));

import { listTasks } from "../tasks.repository";

const ORG = "00000000-0000-0000-0000-000000000001";
const SPRINT = "00000000-0000-0000-0000-0000000000ee";

function whereOf(call = 0): Record<string, unknown> {
  return findMany.mock.calls[call]![0]!.where;
}

beforeEach(() => findMany.mockClear());

describe("listTasks — additive sprintId filter (§1.6)", () => {
  it('sprintId "null" → WHERE sprintId IS NULL (Backlog)', async () => {
    await listTasks(ORG, { sprintId: "null" });
    expect(whereOf()).toMatchObject({ sprintId: null });
  });

  it("sprintId <uuid> → WHERE sprintId = uuid", async () => {
    await listTasks(ORG, { sprintId: SPRINT });
    expect(whereOf()).toMatchObject({ sprintId: SPRINT });
  });

  it("omitted sprintId → no sprintId predicate (back-compat)", async () => {
    await listTasks(ORG, {});
    expect(whereOf()).not.toHaveProperty("sprintId");
  });
});
