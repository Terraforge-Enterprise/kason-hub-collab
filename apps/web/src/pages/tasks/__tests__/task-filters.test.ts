import { describe, it, expect } from "vitest";
import { narrowByPriority, narrowByDue, narrowByCategory, narrowTasks, UNCATEGORIZED } from "../task-filters";
import { DAY_MS, todayStart } from "../tasks-due";
import type { TaskRow } from "@/api/tasks";

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: "t", title: "t", description: null, status: "todo", priority: "low",
    category: null, sortOrder: 0, attachmentKeys: [], assignee: null, relatedUnit: null,
    ticketId: null, sprintId: null, dueOn: null, startedAt: null, completedAt: null, assignedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", ...over,
  };
}

describe("narrowByPriority", () => {
  const rows = [task({ id: "a", priority: "low" }), task({ id: "b", priority: "high" })];
  it("passes through when 0 or 1 selected (≤1 handled server-side)", () => {
    expect(narrowByPriority(rows, [])).toHaveLength(2);
    expect(narrowByPriority(rows, ["high"])).toHaveLength(2);
  });
  it("filters client-side when 2+ selected", () => {
    expect(narrowByPriority(rows, ["high", "medium"]).map((t) => t.id)).toEqual(["b"]);
  });
});

describe("narrowByDue", () => {
  const start = todayStart();
  const overdue = task({ id: "o", dueOn: new Date(start - 2 * DAY_MS).toISOString() });
  const done = task({ id: "d", status: "done", dueOn: new Date(start - 2 * DAY_MS).toISOString() });
  it("keeps only the matching bucket and excludes done", () => {
    expect(narrowByDue([overdue, done], "overdue").map((t) => t.id)).toEqual(["o"]);
  });
  it("passes through when no chip", () => {
    expect(narrowByDue([overdue, done], null)).toHaveLength(2);
  });
});

describe("narrowByCategory", () => {
  const rows = [
    task({ id: "a", category: "Plumbing" }),
    task({ id: "b", category: "Electrical" }),
    task({ id: "c", category: null }),
    task({ id: "d", category: "" }),
  ];
  it("passes through when nothing is selected", () => {
    expect(narrowByCategory(rows, [])).toHaveLength(4);
  });
  it("keeps a single selected name", () => {
    expect(narrowByCategory(rows, ["Plumbing"]).map((t) => t.id)).toEqual(["a"]);
  });
  it("unions multiple selected names (OR)", () => {
    expect(narrowByCategory(rows, ["Plumbing", "Electrical"]).map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("UNCATEGORIZED matches null and empty category", () => {
    expect(narrowByCategory(rows, [UNCATEGORIZED]).map((t) => t.id)).toEqual(["c", "d"]);
  });
  it("mixes a name with UNCATEGORIZED", () => {
    expect(narrowByCategory(rows, ["Plumbing", UNCATEGORIZED]).map((t) => t.id)).toEqual(["a", "c", "d"]);
  });
  it("returns empty when the selected name matches nothing", () => {
    expect(narrowByCategory(rows, ["Aircond"])).toHaveLength(0);
  });
});

describe("narrowTasks", () => {
  it("composes priority, category, then due", () => {
    const start = todayStart();
    const a = task({ id: "a", priority: "high", category: "Plumbing", dueOn: new Date(start - DAY_MS).toISOString() });
    const b = task({ id: "b", priority: "low", category: "Plumbing", dueOn: new Date(start - DAY_MS).toISOString() });
    const c = task({ id: "c", priority: "high", category: "Electrical", dueOn: new Date(start - DAY_MS).toISOString() });
    expect(
      narrowTasks([a, b, c], { priorities: ["high", "medium"], dueChip: "overdue", categories: ["Plumbing"] }).map((t) => t.id),
    ).toEqual(["a"]);
  });
  it("no categories selected leaves category narrowing off", () => {
    const start = todayStart();
    const a = task({ id: "a", priority: "high", category: "Plumbing", dueOn: new Date(start - DAY_MS).toISOString() });
    expect(
      narrowTasks([a], { priorities: [], dueChip: null, categories: [] }).map((t) => t.id),
    ).toEqual(["a"]);
  });
});
