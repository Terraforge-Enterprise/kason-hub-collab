// Shared client-side task narrowing — used by BOTH the board's sprint lanes
// (tasks-board-page.tsx) and the Backlog list (backlog-list.tsx) so the top
// filter bar narrows whichever view is active and the two can't drift.
// Date classification is reused from ./tasks-due (the existing shared module).
import type { TaskPriority } from "@kason/shared";
import type { TaskRow } from "@/api/tasks";
import { classifyDue, type DueBucket } from "./tasks-due";

/** Multi-priority narrowing. 0 or 1 selected → no client narrowing (≤1 is
 *  already applied server-side via the `priority` param); 2+ keeps matches. */
export function narrowByPriority(rows: TaskRow[], priorities: TaskPriority[]): TaskRow[] {
  return rows.filter((t) => priorities.length <= 1 || priorities.includes(t.priority));
}

/** Due-chip narrowing — excludes done (a completed task is not "overdue"). */
export function narrowByDue(rows: TaskRow[], dueChip: DueBucket | null): TaskRow[] {
  if (!dueChip) return rows;
  return rows.filter((t) => !!t.dueOn && t.status !== "done" && classifyDue(t.dueOn) === dueChip);
}

/** Sentinel value for the "Uncategorized" tickbox — matches tasks whose
 *  category is null/empty. NUL-prefixed so it cannot collide with a real,
 *  admin-typed category name. */
export const UNCATEGORIZED = "\u0000uncategorized";

/** Multi-category narrowing. 0 selected → no client narrowing (all rows).
 *  Otherwise keep rows whose category is one of the selected names, OR
 *  (when UNCATEGORIZED is selected) rows with no category. */
export function narrowByCategory(rows: TaskRow[], categories: string[]): TaskRow[] {
  if (categories.length === 0) return rows;
  const wantUncat = categories.includes(UNCATEGORIZED);
  const names = categories.filter((c) => c !== UNCATEGORIZED);
  return rows.filter((t) => {
    if (t.category == null || t.category === "") return wantUncat;
    return names.includes(t.category);
  });
}

export function narrowTasks(
  rows: TaskRow[],
  opts: { priorities: TaskPriority[]; dueChip: DueBucket | null; categories: string[] },
): TaskRow[] {
  return narrowByDue(
    narrowByCategory(narrowByPriority(rows, opts.priorities), opts.categories),
    opts.dueChip,
  );
}
