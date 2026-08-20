// Admin Tasks board (M7). Kanban lanes pool → todo → in_progress → done with
// native HTML5 drag-and-drop, a due-date KPI strip (client-side filter), an
// archived table view, and the TaskDrawer for create/edit.
//
// Flag-gated: route + nav only exist when ENABLE_PHASE2_TASKS is on
// (see router.tsx / navigation.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ListTodo, Paperclip, Plus } from "lucide-react";
import { PHASE2_STATUS_TONES, type TaskPriority } from "@kason/shared";
import { PageHeader, StatusPill } from "@/components/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { PillBar } from "@/components/ui/pill-bar";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { SelectInput } from "@/components/form-ui";
import { EnhancedDataTable } from "@/components/data-table";
import { RoleGate } from "@/components/role-gate";
import { Avatar } from "@/components/avatar";
import { useUsers } from "@/api/users";
import { useActiveWorkCategories } from "@/hooks/use-work-categories";
import {
  TASKS_KEY,
  useMoveTask,
  useRestoreTask,
  useSetTaskSprint,
  useSprints,
  useTasks,
  useTaskAttachmentUrls,
  type SprintRow,
  type TaskRow,
} from "@/api/tasks";
import { TaskDrawer } from "./task-drawer";
import { computeDropPosition } from "./tasks-board-dnd";
import { SprintSelector, type SprintTab } from "./sprint-selector";
import { SprintManageMenu } from "./sprint-manage-menu";
import { SprintDrawer } from "./sprint-drawer";
import { SprintTrendsChart } from "./sprint-trends-chart";
import { BacklogList } from "./backlog-list";
import { CategoryFilterMenu } from "./category-filter-menu";
import { narrowByPriority, narrowByDue, narrowByCategory, UNCATEGORIZED } from "./task-filters";
import { SprintHeader } from "./sprint-header";
import { TaskActionMenu } from "./task-action-menu";
import { UnitChip } from "./unit-chip";

// §HARD-GUARANTEE: the sprint layer is gated entirely behind this flag, read
// exactly like apps/web/src/api/payments.ts (computed once). While it is OFF
// the board renders byte-for-byte as before — no selector, no /sprints fetch,
// original useTasks args, no Move-to-Backlog, no seeded sprintId.
const sprintsEnabled =
  import.meta.env.VITE_ENABLE_PHASE2_SPRINTS === "true" ||
  import.meta.env.VITE_ENABLE_PHASE2_SPRINTS === "1";

type BoardStatus = "pool" | "todo" | "in_progress" | "done";
type ViewMode = "board" | "archived";
type DueBucket = "overdue" | "today" | "week";

const BOARD_STATUSES: BoardStatus[] = ["pool", "todo", "in_progress", "done"];

const STATUS_LABELS: Record<BoardStatus, string> = {
  pool: "Pool",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

const PRIORITY_BADGE: Record<TaskPriority, "rose" | "amber" | "outline"> = {
  high: "rose",
  medium: "amber",
  low: "outline",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local calendar day. */
function todayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Classify a dueOn timestamp against the local calendar: overdue / today / next-7-days. */
function classifyDue(dueOn: string): DueBucket | null {
  const t = new Date(dueOn).getTime();
  const start = todayStart();
  if (t < start) return "overdue";
  if (t < start + DAY_MS) return "today";
  if (t < start + 7 * DAY_MS) return "week";
  return null;
}

function isOverdue(dueOn: string | null): boolean {
  return !!dueOn && classifyDue(dueOn) === "overdue";
}

type DrawerState = { mode: "create" } | { mode: "edit"; task: TaskRow } | null;

export default function TasksBoardPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const view: ViewMode = searchParams.get("view") === "archived" ? "archived" : "board";

  // ── Sprint layer (flag-gated) ──────────────────────────────────────────────
  // useSprints withholds the /sprints fetch while the flag is OFF (enabled:false),
  // so the dark board issues the exact same network calls as before.
  const sprintsQuery = useSprints(undefined, { enabled: sprintsEnabled });
  const sprints = useMemo(() => sprintsQuery.data?.data ?? [], [sprintsQuery.data]);
  const setTaskSprint = useSetTaskSprint();
  // Multiple sprints can be active at once (name-only model). The default board
  // tab adopts the most-recently-STARTED active sprint so it's deterministic;
  // SprintSelector lists every active sprint as a pill to switch between.
  const defaultActiveSprint = useMemo(() => {
    const actives = sprints.filter((s) => s.status === "active");
    if (actives.length === 0) return null;
    return [...actives].sort(
      (a, b) =>
        new Date(b.startedAt ?? b.createdAt).getTime() -
        new Date(a.startedAt ?? a.createdAt).getTime(),
    )[0];
  }, [sprints]);
  // Backlog "Add to sprint" targets: the active sprint AND every planned sprint (O3).
  const targetSprints = useMemo(
    () => sprints.filter((s) => s.status === "active" || s.status === "planned"),
    [sprints],
  );

  // selectedTab is "backlog" or a sprint id. Defaults to "backlog"; once sprints
  // first load, a guarded effect adopts the active sprint as the default exactly
  // once (only while the user hasn't chosen a tab yet).
  const [selectedTab, setSelectedTab] = useState<SprintTab>("backlog");
  const sprintDefaultApplied = useRef(false);
  useEffect(() => {
    if (!sprintsEnabled || sprintDefaultApplied.current) return;
    if (sprints.length === 0) return;
    sprintDefaultApplied.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time default-tab selection, guarded by the sprintDefaultApplied ref.
    if (defaultActiveSprint) setSelectedTab(defaultActiveSprint.id);
  }, [sprintsEnabled, sprints, defaultActiveSprint]);

  const selectedSprint: SprintRow | null =
    selectedTab === "backlog" ? null : sprints.find((s) => s.id === selectedTab) ?? null;
  const isBacklogTab = sprintsEnabled && selectedTab === "backlog";
  const isActiveTab = !!selectedSprint && selectedSprint.status === "active";
  const isPastSprint = !!selectedSprint && selectedSprint.status === "completed";

  // §1.12 New-Task seeding: on an active/planned sprint tab seed sprintId=<tabId>;
  // the Backlog tab (and flag-off) leaves it null → the task lands in the Backlog.
  const defaultSprintId: string | null =
    sprintsEnabled && selectedSprint && selectedSprint.status !== "completed"
      ? selectedSprint.id
      : null;

  const [sprintDrawer, setSprintDrawer] = useState<
    { mode: "create" } | { mode: "edit"; sprint: SprintRow } | null
  >(null);

  const [priorities, setPriorities] = useState<TaskPriority[]>([]);
  // "" = all, "unassigned", or operator user id.
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [dueChip, setDueChip] = useState<DueBucket | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const usersQuery = useUsers();
  const categoriesQuery = useActiveWorkCategories();
  const categoryOptions = useMemo(
    () => (categoriesQuery.data ?? []).map((c) => c.name),
    [categoriesQuery.data],
  );
  // One selected real category narrows server-side (exact match); 0, 2+, or the
  // Uncategorized bucket send no param and narrow client-side via narrowByCategory.
  const serverCategory =
    categories.length === 1 && categories[0] !== UNCATEGORIZED ? categories[0] : undefined;
  const tasksQuery = useTasks({
    // PillBar is multi-select; the API takes a single priority. Exactly one
    // selection narrows server-side; multi-select narrows client-side below.
    priority: priorities.length === 1 ? priorities[0] : undefined,
    assigneeUserId: assigneeFilter || undefined,
    category: serverCategory,
    // Sprint scoping. Flag OFF → `undefined` → sanitizeFilters drops it → the
    // query is byte-for-byte identical to today. Flag ON → "null" (Backlog) or
    // the selected sprint id.
    sprintId: sprintsEnabled ? (selectedTab === "backlog" ? "null" : selectedTab) : undefined,
  });
  const moveTask = useMoveTask();

  const tasks = useMemo(() => tasksQuery.data?.data ?? [], [tasksQuery.data]);

  const operators = (usersQuery.data?.data ?? []).filter((u) => u.status === "active");

  const setView = (next: ViewMode) => {
    const params = new URLSearchParams(searchParams);
    if (next === "board") params.delete("view");
    else params.set("view", next);
    setSearchParams(params, { replace: true });
  };

  // Priority + category narrowing, shared by the KPI counts AND the lanes so
  // chip counts always match the visible cards. Exactly one selection is already
  // narrowed server-side (priority + single-category API params); 2+ / Uncategorized
  // narrow client-side here (idempotent when the server already narrowed).
  const filteredBase = useMemo(
    () => narrowByCategory(narrowByPriority(tasks, priorities), categories),
    [tasks, priorities, categories],
  );

  // ── Due-date KPI strip counts ──────────────────────────────────────────────
  // Done tasks are excluded from every bucket — the strip measures actionable
  // load, and a completed task is not "overdue" (spec adjudication 2026-06-11).
  const dueCounts = useMemo(() => {
    const counts: Record<DueBucket, number> = { overdue: 0, today: 0, week: 0 };
    for (const t of filteredBase) {
      if (!t.dueOn || t.status === "done") continue;
      const bucket = classifyDue(t.dueOn);
      if (bucket) counts[bucket] += 1;
    }
    return counts;
  }, [filteredBase]);

  // Client-side narrowing: due chip on top of the priority+category list.
  const visibleTasks = useMemo(
    () => narrowByDue(filteredBase, dueChip),
    [filteredBase, dueChip],
  );

  const lanes = useMemo(() => {
    const buckets: Record<BoardStatus, TaskRow[]> = {
      pool: [],
      todo: [],
      in_progress: [],
      done: [],
    };
    for (const t of visibleTasks) {
      if (t.status !== "archived") buckets[t.status as BoardStatus].push(t);
    }
    return buckets;
  }, [visibleTasks]);

  function handleDrop(e: React.DragEvent<HTMLElement>, status: BoardStatus) {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/task-id");
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    // When ANY client-narrowing filter is active the rendered lane is a subset
    // of the true server-side lane, so a position computed from the visible
    // cards would splice into the wrong slot. Omit `position` entirely — the
    // server appends via nextLaneSortOrder, which is predictable.
    const filtersActive =
      dueChip !== null ||
      priorities.length > 0 ||
      assigneeFilter !== "" ||
      categories.length > 0;
    let position: number | undefined;
    if (!filtersActive) {
      // Target position from drop Y vs card midpoints — append when below
      // all. The dragged card itself is excluded inside computeDropPosition
      // (the server splices into the lane WITHOUT the moving task).
      const rects = Array.from(
        (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-task-card]"),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.taskId ?? "", midY: r.top + r.height / 2 };
      });
      position = computeDropPosition(rects, e.clientY, taskId);
    }
    moveTask.mutate(
      { taskId, status, ...(position !== undefined ? { position } : {}), updatedAt: task.updatedAt },
      {
        onError: (err) => {
          // Conflict recovery: surface + refetch the board so stale rows heal.
          toast.error(err.message);
          qc.invalidateQueries({ queryKey: TASKS_KEY });
        },
      },
    );
  }

  if (tasksQuery.isError) {
    return <Callout variant="danger">Failed to load tasks. Please refresh.</Callout>;
  }

  if (tasksQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        icon={ListTodo}
        description="Pull work from the pool, move it across the board, and keep unit operations on schedule."
        actions={
          <div className="flex items-center gap-3">
            <Segmented<ViewMode>
              ariaLabel="View"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "board", label: "Board" },
                { value: "archived", label: "Archived" },
              ]}
            />
            {/* Past sprints are frozen → no New Task. Flag off ⇒ isPastSprint is
                always false ⇒ the button always shows (unchanged). */}
            {!isPastSprint && (
              <Button variant="gold" onClick={() => setDrawer({ mode: "create" })}>
                <Plus className="h-4 w-4" /> New Task
              </Button>
            )}
          </div>
        }
      />

      {view === "board" ? (
        <>
          {/* Filters */}
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Priority
                </span>
                <PillBar<TaskPriority>
                  ariaLabel="Priority filter"
                  size="sm"
                  value={priorities}
                  onChange={setPriorities}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Assignee
                </span>
                <SelectInput
                  aria-label="Assignee filter"
                  value={assigneeFilter}
                  onChange={(e) => setAssigneeFilter(e.target.value)}
                  className="min-h-0 w-44 py-1.5"
                >
                  <option value="">All</option>
                  <option value="unassigned">Unassigned</option>
                  {operators.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </SelectInput>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Category
                </span>
                <CategoryFilterMenu
                  value={categories}
                  onChange={setCategories}
                  options={categoryOptions}
                />
              </div>
            </CardContent>
          </Card>

          {/* Due-date KPI strip — chips toggle a client-side dueOn filter */}
          <div className="flex flex-wrap items-center gap-2">
            <DueChip
              label={`${dueCounts.overdue} overdue`}
              active={dueChip === "overdue"}
              tone="rose"
              onClick={() => setDueChip((c) => (c === "overdue" ? null : "overdue"))}
            />
            <DueChip
              label={`${dueCounts.today} due today`}
              active={dueChip === "today"}
              tone="amber"
              onClick={() => setDueChip((c) => (c === "today" ? null : "today"))}
            />
            <DueChip
              label={`${dueCounts.week} due this week`}
              active={dueChip === "week"}
              tone="sky"
              onClick={() => setDueChip((c) => (c === "week" ? null : "week"))}
            />
          </div>

          {/* Sprint selector — only when the flag is on; sits between the due
              strip and the board grid (flag off ⇒ not rendered at all). */}
          {sprintsEnabled && (
            <SprintSelector
              sprints={sprints}
              selected={selectedTab}
              onSelect={setSelectedTab}
              manageMenu={
                <SprintManageMenu
                  sprints={sprints}
                  selected={selectedTab}
                  onNew={() => setSprintDrawer({ mode: "create" })}
                  onEdit={(sprint) => setSprintDrawer({ mode: "edit", sprint })}
                  onDeleted={() => setSelectedTab("backlog")}
                />
              }
            />
          )}

          {isBacklogTab ? (
            // Backlog planning view: the flat priority-ranked list (with its own
            // target-sprint picker) + cross-sprint trends chart, in place of lanes.
            <div className="space-y-4">
              <BacklogList
                targetSprints={targetSprints}
                onOpenTask={(task) => setDrawer({ mode: "edit", task })}
                filters={{
                  priorities,
                  assigneeUserId: assigneeFilter,
                  categories,
                  dueChip,
                }}
              />
              <SprintTrendsChart />
            </div>
          ) : (
            <>
              {selectedSprint && <SprintHeader sprint={selectedSprint} />}
              {/* Board */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {BOARD_STATUSES.map((status) => {
                  const items = lanes[status];
                  return (
                    <Card
                      key={status}
                      className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
                    >
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-semibold flex items-center justify-between">
                          <span>{STATUS_LABELS[status]}</span>
                          <StatusPill tone={PHASE2_STATUS_TONES.task[status]}>
                            {items.length}
                          </StatusPill>
                        </CardTitle>
                      </CardHeader>
                      <CardContent
                        className="space-y-2 min-h-24 md:min-h-[calc(100vh-22rem)]"
                        data-testid={`lane-${status}`}
                        // Completed sprints are frozen → no drag handlers.
                        onDragOver={isPastSprint ? undefined : (e) => e.preventDefault()}
                        onDrop={isPastSprint ? undefined : (e) => handleDrop(e, status)}
                      >
                        {items.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic py-4 text-center">
                            No tasks
                          </p>
                        ) : (
                          items.map((task) => (
                            <TaskCard
                              key={task.id}
                              task={task}
                              draggable={!isPastSprint}
                              onOpen={() => setDrawer({ mode: "edit", task })}
                              // §1.12: per-card Move to Backlog only on an active-sprint tab.
                              onMoveToBacklog={
                                isActiveTab
                                  ? () =>
                                      setTaskSprint.mutate(
                                        { taskId: task.id, updatedAt: task.updatedAt, sprintId: null },
                                        { onError: (err) => toast.error(err.message) },
                                      )
                                  : undefined
                              }
                            />
                          ))
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      ) : (
        <ArchivedView />
      )}

      <TaskDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        mode={drawer?.mode ?? "create"}
        task={drawer?.mode === "edit" ? drawer.task : undefined}
        defaultSprintId={drawer?.mode === "create" ? defaultSprintId : undefined}
      />

      {sprintsEnabled && (
        <SprintDrawer
          open={sprintDrawer !== null}
          onClose={() => setSprintDrawer(null)}
          mode={sprintDrawer?.mode ?? "create"}
          sprint={sprintDrawer?.mode === "edit" ? sprintDrawer.sprint : undefined}
        />
      )}
    </div>
  );
}

function DueChip({
  label,
  active,
  tone,
  onClick,
}: {
  label: string;
  active: boolean;
  tone: "rose" | "amber" | "sky";
  onClick: () => void;
}) {
  const toneClass = {
    rose: active
      ? "border-rose-500 bg-rose-500/15 text-rose-600 dark:text-rose-300"
      : "border-rose-300/60 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10",
    amber: active
      ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : "border-amber-300/60 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10",
    sky: active
      ? "border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300"
      : "border-sky-300/60 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10",
  }[tone];
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${toneClass}`}
    >
      {label}
    </button>
  );
}

// Renders up to 3 image thumbnails for a card. Mounted ONLY when the task has
// attachments, so the per-card download-urls query never fires for empty cards.
function CardThumbnails({ taskId }: { taskId: string }) {
  const urls = useTaskAttachmentUrls(taskId);
  const images = (urls.data?.data ?? []).filter((a) => a.kind === "image").slice(0, 3);
  if (images.length === 0) return null;
  return (
    <div className="mt-2 flex gap-1.5">
      {images.map((img) => (
        <img
          key={img.key}
          src={img.thumbnail ?? img.url}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-12 w-12 rounded-md object-cover border border-border/50"
        />
      ))}
    </div>
  );
}

function TaskCard({
  task,
  onOpen,
  draggable = true,
  onMoveToBacklog,
}: {
  task: TaskRow;
  onOpen: () => void;
  draggable?: boolean;
  onMoveToBacklog?: () => void;
}) {
  const overdue = isOverdue(task.dueOn);
  return (
    <div
      data-task-card
      data-task-id={task.id}
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/task-id", task.id)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`w-full ${draggable ? "cursor-grab" : "cursor-default"} rounded-lg border border-border/50 bg-background/40 p-3 text-left backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{task.title}</p>
          {task.relatedUnit && <UnitChip unit={task.relatedUnit} className="mt-0.5 max-w-full" />}
        </div>
        <TaskActionMenu task={task} onEdit={onOpen} onMoveToBacklog={onMoveToBacklog} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.category && (
          <Badge variant="ghost" className="text-[10px]">
            {task.category}
          </Badge>
        )}
        <Badge variant={PRIORITY_BADGE[task.priority]} className="text-[10px] uppercase">
          {task.priority}
        </Badge>
        {task.attachmentKeys.length > 0 && (
          <Badge variant="ghost" className="text-[10px] gap-0.5">
            <Paperclip className="h-3 w-3" />
            {task.attachmentKeys.length}
          </Badge>
        )}
      </div>

      {task.description && (
        <p className="mt-2 text-xs text-muted-foreground line-clamp-1">{task.description}</p>
      )}

      {task.attachmentKeys.length > 0 && <CardThumbnails taskId={task.id} />}

      <div className="mt-2 flex items-center justify-between gap-2">
        {task.assignee ? (
          <span
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            title={task.assignee.fullName}
          >
            <Avatar src={task.assignee.photoUrl} name={task.assignee.fullName} size="sm" />
            <span className="truncate">{task.assignee.fullName}</span>
          </span>
        ) : (
          <span className="text-xs italic text-muted-foreground">Unassigned</span>
        )}
        {task.dueOn && (
          <span
            className={`shrink-0 text-xs ${overdue ? "text-rose-500 font-medium" : "text-muted-foreground"}`}
          >
            Due {task.dueOn.slice(0, 10)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Archived view ─────────────────────────────────────────────────────────────

function ArchivedView() {
  const archivedQuery = useTasks({ status: "archived" });
  const restoreTask = useRestoreTask();
  const [confirmRestore, setConfirmRestore] = useState<TaskRow | null>(null);

  if (archivedQuery.isLoading) {
    return (
      <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)] animate-pulse" />
    );
  }
  if (archivedQuery.isError) {
    return <Callout variant="danger">Failed to load archived tasks. Please refresh.</Callout>;
  }

  const rows = archivedQuery.data?.data ?? [];

  return (
    <>
      <EnhancedDataTable
        data={rows}
        emptyMessage="No archived tasks."
        columns={[
          {
            key: "title",
            label: "Title",
            sortable: true,
            sortValue: (t) => t.title,
            render: (t) => <span className="font-medium">{t.title}</span>,
          },
          {
            key: "assignee",
            label: "Assignee",
            render: (t) =>
              t.assignee ? (
                <span className="flex items-center gap-2">
                  <Avatar src={t.assignee.photoUrl} name={t.assignee.fullName} size="sm" />
                  {t.assignee.fullName}
                </span>
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              ),
          },
          {
            key: "unit",
            label: "Unit",
            render: (t) =>
              t.relatedUnit ? (
                <Badge variant="outline">{t.relatedUnit.unitCode}</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          {
            key: "archivedAt",
            label: "Archived",
            sortable: true,
            sortValue: (t) => t.updatedAt,
            render: (t) => t.updatedAt.slice(0, 10),
          },
          {
            key: "actions",
            label: "",
            className: "text-right",
            render: (t) => (
              <RoleGate min="manager">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={restoreTask.isPending}
                  onClick={() => setConfirmRestore(t)}
                >
                  Restore
                </Button>
              </RoleGate>
            ),
          },
        ]}
      />
      <ConfirmAlert
        open={confirmRestore !== null}
        onCancel={() => setConfirmRestore(null)}
        onConfirm={() => {
          const target = confirmRestore;
          setConfirmRestore(null);
          if (!target) return;
          restoreTask.mutate(
            { taskId: target.id, updatedAt: target.updatedAt },
            { onError: (err) => toast.error(err.message) },
          );
        }}
        title="Restore this task?"
        body={`"${confirmRestore?.title ?? ""}" returns to the board.`}
        confirmLabel="Restore"
      />
    </>
  );
}
