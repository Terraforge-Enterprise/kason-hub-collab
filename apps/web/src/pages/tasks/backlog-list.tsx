// Backlog: flat, priority-ranked list of un-sprinted tasks (sprintId IS NULL).
// Per-row "Add to sprint" + bulk "Add N" set membership via the existing
// PATCH /tasks/:id (useSetTaskSprint), targeting the sprint chosen in the
// target-sprint picker (active OR any planned sprint — O3). Replaces the lane
// grid on the Backlog tab.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Avatar } from "@/components/avatar";
import { TaskActionMenu } from "./task-action-menu";
import type { TaskPriority } from "@kason/shared";
import { useSetTaskSprint, useTasks, type SprintRow, type TaskRow } from "@/api/tasks";
import { narrowTasks, UNCATEGORIZED } from "./task-filters";
import { UnitChip } from "./unit-chip";
import type { DueBucket } from "./tasks-due";

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const PRIORITY_BADGE = { high: "rose", medium: "amber", low: "outline" } as const;

function sprintLabel(s: SprintRow): string {
  return s.name ?? `Sprint ${s.seq}`;
}

/** Active sprint first, then planned sprints (seq asc) — the picker order. */
function orderTargets(sprints: SprintRow[]): SprintRow[] {
  const active = sprints.filter((s) => s.status === "active");
  const planned = sprints.filter((s) => s.status === "planned").sort((a, b) => a.seq - b.seq);
  return [...active, ...planned];
}

export type BacklogFilters = {
  priorities: TaskPriority[];
  assigneeUserId: string; // "" = all, "unassigned", or operator user id
  categories: string[];
  dueChip: DueBucket | null;
};

const NO_FILTERS: BacklogFilters = { priorities: [], assigneeUserId: "", categories: [], dueChip: null };

export function BacklogList({
  targetSprints,
  onOpenTask,
  filters = NO_FILTERS,
}: {
  targetSprints: SprintRow[];
  onOpenTask: (task: TaskRow) => void;
  filters?: BacklogFilters;
}) {
  // Mirror the parent's server params so react-query DEDUPES with the board's
  // backlog-tab query (same sanitized key ⇒ one network request). Exactly one
  // priority narrows server-side; 2+ narrows client-side via narrowTasks below.
  const backlogQuery = useTasks({
    sprintId: "null",
    priority: filters.priorities.length === 1 ? filters.priorities[0] : undefined,
    assigneeUserId: filters.assigneeUserId || undefined,
    category:
      filters.categories.length === 1 && filters.categories[0] !== UNCATEGORIZED
        ? filters.categories[0]
        : undefined,
  });
  const setTaskSprint = useSetTaskSprint();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const targets = useMemo(() => orderTargets(targetSprints), [targetSprints]);
  const [targetId, setTargetId] = useState<string>(() => targets[0]?.id ?? "");
  useEffect(() => {
    if (!targets.some((s) => s.id === targetId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the picker valid when the candidate list changes.
      setTargetId(targets[0]?.id ?? "");
    }
  }, [targets, targetId]);

  const tasks = useMemo(() => {
    const rows = (backlogQuery.data?.data ?? []).filter((t) => t.status !== "archived");
    const narrowed = narrowTasks(rows, {
      priorities: filters.priorities,
      dueChip: filters.dueChip,
      categories: filters.categories,
    });
    return [...narrowed].sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
    );
  }, [backlogQuery.data, filters]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addToSprint(ids: string[]) {
    if (!targetId) return;
    for (const id of ids) {
      const task = tasks.find((t) => t.id === id);
      if (!task) continue;
      setTaskSprint.mutate(
        { taskId: task.id, updatedAt: task.updatedAt, sprintId: targetId },
        { onError: (err) => toast.error(err.message) },
      );
    }
  }

  if (backlogQuery.isError) {
    return <Callout variant="danger">Failed to load the backlog. Please refresh.</Callout>;
  }
  if (backlogQuery.isLoading) {
    return (
      <div className="h-48 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)] animate-pulse" />
    );
  }

  const canTarget = targets.length > 0 && targetId !== "";

  return (
    <div className="space-y-3" data-testid="backlog-list">
      {canTarget && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/60 px-4 py-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Add to</span>
            <select
              data-testid="backlog-target-picker"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              className="rounded-md border border-border/60 bg-background px-2 py-1 text-sm text-foreground"
            >
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {sprintLabel(s)}
                  {s.status === "planned" ? " (planned)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="gold"
            size="sm"
            data-testid="backlog-add-bulk"
            disabled={selected.size === 0 || setTaskSprint.isPending}
            onClick={() => {
              addToSprint([...selected]);
              setSelected(new Set());
            }}
          >
            Add {selected.size}
          </Button>
        </div>
      )}

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="divide-y divide-border/40 p-0">
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm italic text-muted-foreground">
              Backlog is empty.
            </p>
          ) : (
            tasks.map((task) => {
              return (
                <div
                  key={task.id}
                  data-backlog-row
                  data-task-id={task.id}
                  className="flex items-start gap-3 px-4 py-3 transition hover:bg-background/60"
                >
                  <input
                    type="checkbox"
                    data-testid={`backlog-check-${task.id}`}
                    aria-label={`Select ${task.title}`}
                    checked={selected.has(task.id)}
                    onChange={() => toggle(task.id)}
                    className="mt-1 h-4 w-4 rounded border-border/60"
                  />
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                  >
                    <span className="min-w-0 max-w-full truncate text-sm font-semibold text-foreground">
                      {task.title}
                    </span>
                    {task.relatedUnit && <UnitChip unit={task.relatedUnit} className="max-w-full" />}
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="flex items-center gap-1.5">
                      {task.category && (
                        <Badge variant="ghost" className="text-[10px]">
                          {task.category}
                        </Badge>
                      )}
                      <Badge variant={PRIORITY_BADGE[task.priority]} className="text-[10px] uppercase">
                        {task.priority}
                      </Badge>
                    </span>
                    <span className="flex items-center gap-1.5">
                      {task.assignee ? (
                        <span
                          className="flex items-center gap-1.5 text-xs text-muted-foreground"
                          title={task.assignee.fullName}
                        >
                          <Avatar src={task.assignee.photoUrl} name={task.assignee.fullName} size="sm" />
                          <span className="hidden sm:inline">{task.assignee.fullName}</span>
                        </span>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">Unassigned</span>
                      )}
                      {canTarget && (
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid={`backlog-add-${task.id}`}
                          disabled={setTaskSprint.isPending}
                          onClick={() => addToSprint([task.id])}
                        >
                          Add to sprint
                        </Button>
                      )}
                      <TaskActionMenu task={task} onEdit={() => onOpenTask(task)} />
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
