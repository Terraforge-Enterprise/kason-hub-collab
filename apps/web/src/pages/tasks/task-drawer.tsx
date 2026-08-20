// Task create/edit drawer (M7). FormDrawer + controlled FormState that resets
// on open (admin-form-drawer pattern). Create success STAYS OPEN and switches
// to edit mode so the operator can attach files immediately.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarPlus } from "lucide-react";
import type { TaskPriority, UpdateTaskInput } from "@kason/shared";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Segmented } from "@/components/ui/segmented";
import { Callout } from "@/components/ui/callout";
import { Avatar } from "@/components/avatar";
import { Field, SelectInput, TextAreaInput, TextInput } from "@/components/form-ui";
import { CategoryCombobox } from "@/components/category-combobox";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { formatDateTimeMY } from "@/components/format";
import { buildGoogleCalendarUrl } from "@/lib/google-calendar";
import { useUsers } from "@/api/users";
import {
  TASKS_KEY,
  useArchiveTask,
  useAssignTask,
  useCreateTask,
  useDeleteTask,
  useMoveTask,
  useRestoreTask,
  useUpdateTask,
  type TaskRow,
} from "@/api/tasks";
import { UnitTypeahead } from "./unit-typeahead";
import { TaskAttachments } from "./task-attachments";

type BoardStatus = "pool" | "todo" | "in_progress" | "done";

export type TaskDrawerProps = {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  task?: TaskRow;
  /** Spawn-from-ticket prefill (Task 9 wires this from the unit ticket panel). */
  prefill?: { ticketId?: string; relatedUnitId?: string; relatedUnitLabel?: string };
  /** §1.12: when the board is on an active/planned sprint tab, seed the new
   *  task's sprintId so "New Task" lands in that sprint (null/omitted = Backlog). */
  defaultSprintId?: string | null;
};

type FormState = {
  title: string;
  description: string;
  priority: TaskPriority;
  category: string;
  /** yyyy-mm-dd from <input type="date">; "" = no due date. */
  dueOn: string;
  relatedUnitId: string | null;
  relatedUnitLabel: string;
  /** "" = unassigned. */
  assigneeUserId: string;
};

type FormErrors = Partial<Record<"title", string>>;

/**
 * Convert a yyyy-mm-dd date-input value to a Z-normalized ISO datetime.
 * The API's zod `.datetime()` REJECTS offset timestamps, so we anchor the
 * day at UTC midnight explicitly instead of letting the runtime apply the
 * local timezone.
 */
function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

function blankForm(prefill?: TaskDrawerProps["prefill"]): FormState {
  return {
    title: "",
    description: "",
    priority: "medium",
    category: "",
    dueOn: "",
    relatedUnitId: prefill?.relatedUnitId ?? null,
    relatedUnitLabel: prefill?.relatedUnitLabel ?? "",
    assigneeUserId: "",
  };
}

function formFromTask(task: TaskRow): FormState {
  return {
    title: task.title,
    description: task.description ?? "",
    priority: task.priority,
    category: task.category ?? "",
    dueOn: task.dueOn ? task.dueOn.slice(0, 10) : "",
    relatedUnitId: task.relatedUnit?.id ?? null,
    relatedUnitLabel: task.relatedUnit
      ? `${task.relatedUnit.unitCode} · ${task.relatedUnit.propertyName}`
      : "",
    assigneeUserId: task.assignee?.id ?? "",
  };
}

export function TaskDrawer({ open, onClose, mode, task, prefill, defaultSprintId }: TaskDrawerProps) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = user?.role === "manager" || user?.role === "admin";

  const usersQuery = useUsers();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const moveTask = useMoveTask();
  const assignTask = useAssignTask();
  const archiveTask = useArchiveTask();
  const restoreTask = useRestoreTask();
  const deleteTask = useDeleteTask();

  // Latest server snapshot of the task being edited. Seeded from the prop on
  // open; refreshed from every mutation response so subsequent submits carry
  // the current updatedAt (optimistic-concurrency token).
  const [liveTask, setLiveTask] = useState<TaskRow | null>(null);
  // Set when a create succeeded in this open cycle — flips the drawer to edit
  // mode without closing so attachments can be added.
  const [justCreated, setJustCreated] = useState(false);

  const [form, setForm] = useState<FormState>(() => blankForm(prefill));
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open form snapshot; same pattern as admin-form-drawer, and the cheap sync reset beats remount-keying the whole drawer.
      setJustCreated(false);
      if (mode === "edit" && task) {
        setLiveTask(task);
        setForm(formFromTask(task));
      } else {
        setLiveTask(null);
        setForm(blankForm(prefill));
      }
      setErrors({});
    }
    // prefill is captured at open time only (parent passes a fresh object per render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, task?.id]);

  const effectiveMode: "create" | "edit" = liveTask ? "edit" : mode;
  const current = liveTask ?? (mode === "edit" ? task ?? null : null);
  const isArchived = current?.status === "archived";

  const operators = (usersQuery.data?.data ?? []).filter((u) => u.status === "active");

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "title") setErrors((prev) => ({ ...prev, title: undefined }));
  }

  function refreshFromBoard() {
    qc.invalidateQueries({ queryKey: TASKS_KEY });
  }

  /**
   * Conflict recovery for submit failures (typically a 409 from the
   * updatedAt-in-WHERE concurrency check): refetch the board AND reseed the
   * drawer's task snapshot so the next submit carries a fresh token. If the
   * reseed itself fails (task deleted/archived elsewhere), close the drawer —
   * reopening loads fresh data.
   */
  async function recoverFromConflict(taskId: string) {
    qc.invalidateQueries({ queryKey: TASKS_KEY });
    try {
      const res = await apiFetch<{ data: TaskRow }>(`/tasks/${taskId}`);
      setLiveTask(res.data);
    } catch {
      onClose();
    }
  }

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.title.trim()) errs.title = "Title is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (effectiveMode === "create") {
      createTask.mutate(
        {
          title: form.title.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          priority: form.priority,
          ...(form.category.trim() ? { category: form.category.trim() } : {}),
          assigneeUserId: form.assigneeUserId || null,
          relatedUnitId: form.relatedUnitId,
          ...(prefill?.ticketId ? { ticketId: prefill.ticketId } : {}),
          dueOn: form.dueOn ? toIsoFromDateInput(form.dueOn) : null,
          // §1.12: seed the sprint when "New Task" is launched from an
          // active/planned sprint tab. Omitted when null/undefined → the API
          // defaults sprintId to null = Backlog (flag-off / Backlog-tab parity).
          ...(defaultSprintId ? { sprintId: defaultSprintId } : {}),
        },
        {
          onSuccess: (res) => {
            // STAY OPEN — switch to edit mode so attachments can be added.
            setLiveTask(res.data);
            setJustCreated(true);
          },
          onError: (err) => toast.error(err.message),
        },
      );
      return;
    }

    if (!current) return;

    // Send only changed fields.
    const patch: Partial<Omit<UpdateTaskInput, "taskId" | "updatedAt">> = {};
    if (form.title.trim() !== current.title) patch.title = form.title.trim();
    const description = form.description.trim() || null;
    if (description !== current.description) patch.description = description;
    if (form.priority !== current.priority) patch.priority = form.priority;
    const category = form.category.trim() || null;
    if (category !== current.category) patch.category = category;
    if ((form.relatedUnitId ?? null) !== (current.relatedUnit?.id ?? null)) {
      patch.relatedUnitId = form.relatedUnitId;
    }
    const currentDueDay = current.dueOn ? current.dueOn.slice(0, 10) : "";
    if (form.dueOn !== currentDueDay) {
      patch.dueOn = form.dueOn ? toIsoFromDateInput(form.dueOn) : null;
    }

    const assigneeChanged = form.assigneeUserId !== (current.assignee?.id ?? "");
    const hasFieldChanges = Object.keys(patch).length > 0;

    const runAssign = (updatedAt: string, opts: { afterUpdate: boolean }) =>
      assignTask.mutate(
        { taskId: current.id, updatedAt, assigneeUserId: form.assigneeUserId || null },
        {
          onSuccess: (res) => {
            setLiveTask(res.data);
            onClose();
          },
          onError: (err) => {
            // Partial-success wording when the update leg already landed.
            toast.error(
              opts.afterUpdate
                ? `Details saved, but the assignee change failed: ${err.message}`
                : err.message,
            );
            void recoverFromConflict(current.id);
          },
        },
      );

    if (hasFieldChanges) {
      updateTask.mutate(
        { taskId: current.id, updatedAt: current.updatedAt, ...patch },
        {
          onSuccess: (res) => {
            setLiveTask(res.data);
            if (assigneeChanged) runAssign(res.data.updatedAt, { afterUpdate: true });
            else onClose();
          },
          onError: (err) => {
            toast.error(err.message);
            void recoverFromConflict(current.id);
          },
        },
      );
    } else if (assigneeChanged) {
      runAssign(current.updatedAt, { afterUpdate: false });
    } else {
      onClose();
    }
  }

  const isPending =
    createTask.isPending || updateTask.isPending || assignTask.isPending;

  const title = effectiveMode === "create" ? "New task" : "Edit task";
  const description =
    effectiveMode === "create"
      ? "Add an operations task to the pool."
      : current?.title ?? "Update task details.";

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      onSubmit={handleSubmit}
      submit={{
        label: effectiveMode === "create" ? "Create task" : "Save changes",
        pendingLabel: effectiveMode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
      secondaryActions={[
        effectiveMode === "edit" && form.dueOn
          ? {
              label: "Open in Google Calendar",
              variant: "ghost" as const,
              icon: CalendarPlus,
              onClick: () =>
                window.open(
                  buildGoogleCalendarUrl({
                    title: form.title || current?.title || "Task",
                    dueOn: toIsoFromDateInput(form.dueOn),
                  }),
                  "_blank",
                  "noopener",
                ),
            }
          : null,
        effectiveMode === "edit" && current && !isArchived && canManage
          ? {
              label: "Archive",
              variant: "destructive" as const,
              pending: archiveTask.isPending,
              pendingLabel: "Archiving…",
              confirm: {
                title: "Archive this task?",
                body: "The task leaves the board and moves to the Archived view. A manager can restore it later.",
                confirmLabel: "Archive",
                destructive: true,
              },
              onClick: () =>
                archiveTask.mutate(
                  { taskId: current.id, updatedAt: current.updatedAt },
                  {
                    onSuccess: () => {
                      refreshFromBoard();
                      onClose();
                    },
                    onError: (err) => {
                      toast.error(err.message);
                      refreshFromBoard();
                    },
                  },
                ),
            }
          : null,
        effectiveMode === "edit" && current && isArchived && canManage
          ? {
              label: "Restore",
              variant: "outline" as const,
              pending: restoreTask.isPending,
              pendingLabel: "Restoring…",
              onClick: () =>
                restoreTask.mutate(
                  { taskId: current.id, updatedAt: current.updatedAt },
                  {
                    onSuccess: () => {
                      refreshFromBoard();
                      onClose();
                    },
                    onError: (err) => {
                      toast.error(err.message);
                      refreshFromBoard();
                    },
                  },
                ),
            }
          : null,
        effectiveMode === "edit" && current && canManage
          ? {
              label: "Delete",
              variant: "destructive" as const,
              pending: deleteTask.isPending,
              pendingLabel: "Deleting…",
              confirm: {
                title: "Permanently delete this task?",
                body: "If it's linked to a unit, its ticket and ticket history are deleted too. This can't be undone.",
                confirmLabel: "Delete",
                destructive: true,
              },
              onClick: () =>
                deleteTask.mutate(current.id, {
                  onSuccess: () => {
                    toast.success("Task deleted");
                    onClose();
                  },
                  onError: (err) => toast.error(err.message),
                }),
            }
          : null,
      ]}
    >
      <div className="grid gap-4">
        {justCreated && (
          <Callout variant="info">
            Task created — add attachments below or close.
          </Callout>
        )}

        <Field label="Title" error={errors.title}>
          <TextInput
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="e.g. Replace aircond filter"
            required
            autoFocus={effectiveMode === "create"}
          />
        </Field>

        <Field label="Description">
          <TextAreaInput
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What needs doing, and any context the assignee needs…"
            rows={3}
          />
        </Field>

        <Field label="Priority">
          <Segmented<TaskPriority>
            ariaLabel="Priority"
            value={form.priority}
            onChange={(next) => set("priority", next)}
            size="sm"
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <CategoryCombobox
            value={form.category}
            onChange={(v) => set("category", v)}
            label="Category"
            hint="Pick a category, or Other for free text."
          />
          <Field label="Due date">
            <TextInput
              type="date"
              value={form.dueOn}
              onChange={(e) => set("dueOn", e.target.value)}
            />
          </Field>
        </div>

        <Field label="Related unit" hint="Optional — link this task to a rental unit.">
          <UnitTypeahead
            value={form.relatedUnitId}
            displayName={form.relatedUnitLabel}
            onSelect={(id, label) => {
              set("relatedUnitId", id);
              set("relatedUnitLabel", label);
            }}
            onClear={() => {
              set("relatedUnitId", null);
              set("relatedUnitLabel", "");
            }}
          />
        </Field>

        <Field label="Assignee">
          <SelectInput
            value={form.assigneeUserId}
            onChange={(e) => set("assigneeUserId", e.target.value)}
          >
            <option value="">Unassigned</option>
            {operators.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </SelectInput>
          {(() => {
            const picked = operators.find((u) => u.id === form.assigneeUserId);
            return picked ? (
              <span className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <Avatar src={picked.photoUrl} name={picked.fullName} size="sm" />
                {picked.fullName}
              </span>
            ) : null;
          })()}
        </Field>

        {effectiveMode === "edit" && current && !isArchived && (
          <Field
            label="Status"
            hint={
              current.ticketId != null && current.status === "done"
                ? "Pulling it out of Done reopens the linked ticket."
                : "Moves the task between lanes — same as dragging on the board."
            }
          >
            <Segmented<BoardStatus>
              ariaLabel="Status"
              value={current.status as BoardStatus}
              size="sm"
              // Lock while a move is in flight so rapid clicks don't race with
              // a stale updatedAt concurrency token.
              disabled={moveTask.isPending}
              onChange={(next) =>
                moveTask.mutate(
                  { taskId: current.id, status: next, updatedAt: current.updatedAt },
                  {
                    onSuccess: (res) => setLiveTask(res.data),
                    onError: (err) => {
                      toast.error(err.message);
                      refreshFromBoard();
                    },
                  },
                )
              }
              options={[
                { value: "pool", label: "Pool" },
                { value: "todo", label: "To do" },
                { value: "in_progress", label: "In progress" },
                { value: "done", label: "Done" },
              ]}
            />
          </Field>
        )}

        {effectiveMode === "edit" && current && (
          <p className="text-xs text-muted-foreground">
            Created {formatDateTimeMY(current.createdAt)}
          </p>
        )}

        {effectiveMode === "edit" && current?.assignedAt && (
          <p className="text-xs text-muted-foreground">
            Assigned {current.assignee ? `${current.assignee.fullName} ` : ""}on{" "}
            {formatDateTimeMY(current.assignedAt)}
          </p>
        )}

        {effectiveMode === "edit" && current && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-[var(--text-primary)]">Attachments</span>
            <TaskAttachments taskId={current.id} attachmentKeys={current.attachmentKeys} />
          </div>
        )}
      </div>
    </FormDrawer>
  );
}
