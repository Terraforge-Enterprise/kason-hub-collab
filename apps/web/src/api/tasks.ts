// Typed react-query hooks for the Tasks + Tickets module (M7).
//
// IMPORTANT — datetime inputs (dueOn, occurredOn, updatedAt) MUST be
// Z-normalized ISO strings. The API validates them with zod `.datetime()`,
// which REJECTS offset timestamps like "2026-06-11T10:00:00+08:00".
// Callers must pass `new Date(value).toISOString()` (UTC "Z" suffix).
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AssignTaskInput,
  CreateSprintInput,
  CreateTaskInput,
  CreateTicketInput,
  ListSprintsQueryInput,
  ListTasksQueryInput,
  ListTicketsQueryInput,
  MoveTaskInput,
  QuickLogInput,
  ResolveTicketInput,
  SprintLifecycleInput,
  TaskPriority,
  TaskStatus,
  TicketStatus,
  UpdateSprintInput,
  UpdateTaskInput,
  UpdateTicketInput,
} from "@kason/shared";
import { apiFetch } from "@/lib/api-client";

// ─── Row types ───────────────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/tasks/tasks.types.ts — keep in sync.

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  sortOrder: number | null;
  attachmentKeys: string[];
  assignee: { id: string; fullName: string; photoUrl: string | null } | null;
  relatedUnit: { id: string; unitCode: string; propertyName: string } | null;
  ticketId: string | null;
  sprintId: string | null;
  dueOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
  assignedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Sprint row types ────────────────────────────────────────────────────────
// Mirrors apps/api/src/modules/tasks/sprints.types.ts — keep in sync.

/** Live counts for planned/active sprints; snapshot columns for completed. */
export type SprintSummary = {
  committed: number; // completed + carried
  completed: number;
  carried: number; // incomplete still attached (live) OR carriedOverCount (snapshot)
  completionPct: number; // Math.round(completed / committed * 100); 0 when committed === 0
};

export type SprintRow = {
  id: string;
  seq: number;
  name: string | null; // null => UI renders `Sprint ${seq}`
  goal: string | null;
  status: "planned" | "active" | "completed";
  startsOn: string | null; // ISO Z
  endsOn: string | null; // ISO Z
  startedAt: string | null;
  completedAt: string | null;
  summary: SprintSummary;
  createdAt: string;
  updatedAt: string; // concurrency token the client echoes back on mutate
};

/** One cross-sprint trend bar (Spec 3 §5/§7) — from the close-snapshot columns. */
export type SprintTrendPoint = {
  seq: number;
  name: string | null; // null => UI renders `Sprint ${seq}`
  completed: number; // completedCount ?? 0
  carried: number; // carriedOverCount ?? 0
  completionRate: number; // 0 when committed === 0
};

export type TicketRow = {
  id: string;
  unitId: string;
  title: string;
  description: string | null;
  category: string | null;
  status: TicketStatus;
  warrantyFlag: boolean;
  attachmentKeys: string[];
  historyCount: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HistoryRow = {
  id: string;
  ticketId: string;
  unitId: string;
  entry: string;
  attachmentKeys: string[];
  actor: { id: string; fullName: string } | null;
  ticket: { id: string; title: string; status: TicketStatus } | null;
  occurredOn: string;
  createdAt: string;
};

/** Signed download URL for one attachment (thumbnail is image-only). */
export type AttachmentUrl = {
  key: string;
  url: string;
  thumbnail: string | null;
  kind: "image" | "video" | "pdf";
  /** Set when the file lives on the paired entity (ticket ⇄ task union view) — read-only here. */
  linkedFrom?: "ticket" | "task";
};

// ─── Query keys ──────────────────────────────────────────────────────────────

export const TASKS_KEY = ["tasks"] as const;

export const SPRINTS_KEY = ["sprints"] as const;

export function taskAttachmentsKey(taskId: string) {
  return [...TASKS_KEY, taskId, "attachments"] as const;
}

export function unitTicketsKey(unitId: string) {
  return ["tickets", "unit", unitId] as const;
}

export function ticketAttachmentsKey(ticketId: string) {
  return ["tickets", ticketId, "attachments"] as const;
}

export function unitHistoryKey(unitId: string) {
  return ["history", "unit", unitId] as const;
}

export function unitHistoryAttachmentsKey(unitId: string) {
  return [...unitHistoryKey(unitId), "attachments"] as const;
}

// Drop undefined/"" entries from a filters object. The sanitized object feeds
// BOTH the query key and the querystring, so {status: ""} and {} share one
// cache entry (mirrors users.ts's normalize-the-key convention). Empty strings
// are dropped because the API's .strict() query schemas reject "" enum values,
// and select-driven filter UIs commonly emit "" for "no filter".
function sanitizeFilters(filters: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

function toQueryString(sanitized: Record<string, string>): string {
  const entries = Object.entries(sanitized);
  return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
}

// ─── Task board ──────────────────────────────────────────────────────────────

export function useTasks(filters: ListTasksQueryInput = {}) {
  const sanitized = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...TASKS_KEY, sanitized],
    queryFn: () => apiFetch<{ data: TaskRow[] }>(`/tasks${toQueryString(sanitized)}`),
    placeholderData: (prev) => prev,
  });
}

export function useTask(taskId: string | undefined) {
  return useQuery({
    queryKey: [...TASKS_KEY, taskId],
    queryFn: () => apiFetch<{ data: TaskRow }>(`/tasks/${taskId}`),
    enabled: !!taskId,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      apiFetch<{ data: TaskRow }>("/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: UpdateTaskInput) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: MoveTaskInput) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}/status`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useAssignTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...body }: AssignTaskInput) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}/assignee`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useArchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, updatedAt }: { taskId: string; updatedAt: string }) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}/archive`, {
        method: "POST",
        body: JSON.stringify({ updatedAt }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useRestoreTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, updatedAt }: { taskId: string; updatedAt: string }) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}/restore`, {
        method: "POST",
        body: JSON.stringify({ updatedAt }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      apiFetch<{ data: { id: string } }>(`/tasks/${taskId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  });
}

// ─── Task attachments ────────────────────────────────────────────────────────

export function useTaskAttachmentUrls(taskId: string | undefined) {
  return useQuery({
    queryKey: taskAttachmentsKey(taskId ?? ""),
    queryFn: () =>
      apiFetch<{ data: AttachmentUrl[] }>(`/tasks/${taskId}/attachments/download-urls`),
    enabled: !!taskId,
  });
}

export function useRemoveTaskAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, key }: { taskId: string; key: string }) =>
      apiFetch<{ data: { attachmentKeys: string[] } }>(
        `/tasks/${taskId}/attachments?key=${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, { taskId }) => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
      // Prefix-redundant (taskAttachmentsKey starts with TASKS_KEY) — kept
      // explicit for symmetry with useRemoveTicketAttachment's key pair.
      qc.invalidateQueries({ queryKey: taskAttachmentsKey(taskId) });
    },
  });
}

// ─── Tickets (per unit) ──────────────────────────────────────────────────────
// unitId is a hook-construction arg on the /tickets/:id mutations because the
// route doesn't carry it, but the unit-scoped cache keys need it.

export function useUnitTickets(
  unitId: string | undefined,
  filters: ListTicketsQueryInput = {},
) {
  const sanitized = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...unitTicketsKey(unitId ?? ""), sanitized],
    queryFn: () =>
      apiFetch<{ data: TicketRow[] }>(`/units/${unitId}/tickets${toQueryString(sanitized)}`),
    enabled: !!unitId,
    placeholderData: (prev) => prev,
  });
}

export function useCreateTicket(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateTicketInput, "unitId">) =>
      apiFetch<{ data: TicketRow }>(`/units/${unitId}/tickets`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) }),
  });
}

export function useUpdateTicket(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, ...body }: UpdateTicketInput) =>
      apiFetch<{ data: TicketRow }>(`/tickets/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
      // Edits can change title/status (open↔in_progress), both embedded in
      // HistoryRow.ticket — keep the unit's history fresh too.
      qc.invalidateQueries({ queryKey: unitHistoryKey(unitId) });
    },
  });
}

export function useResolveTicket(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, ...body }: ResolveTicketInput) =>
      apiFetch<{ data: { ticket: TicketRow; history: HistoryRow } }>(
        `/tickets/${ticketId}/resolve`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      // Resolution writes an immutable history row (with optional evidence),
      // so the unit's history + history-attachment caches go stale too.
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryAttachmentsKey(unitId) });
    },
  });
}

export function useVoidTicket(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, updatedAt }: { ticketId: string; updatedAt: string }) =>
      apiFetch<{ data: TicketRow }>(`/tickets/${ticketId}/void`, {
        method: "POST",
        body: JSON.stringify({ updatedAt }),
      }),
    onSuccess: () => {
      // History rows embed { ticket: { status } } — lifecycle changes stale both.
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryKey(unitId) });
    },
  });
}

export function useReopenTicket(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, updatedAt }: { ticketId: string; updatedAt: string }) =>
      apiFetch<{ data: TicketRow }>(`/tickets/${ticketId}/reopen`, {
        method: "POST",
        body: JSON.stringify({ updatedAt }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryKey(unitId) });
    },
  });
}

// ─── Ticket attachments ──────────────────────────────────────────────────────

export function useTicketAttachmentUrls(ticketId: string | undefined) {
  return useQuery({
    queryKey: ticketAttachmentsKey(ticketId ?? ""),
    queryFn: () =>
      apiFetch<{ data: AttachmentUrl[] }>(`/tickets/${ticketId}/attachments/download-urls`),
    enabled: !!ticketId,
  });
}

export function useRemoveTicketAttachment(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, key }: { ticketId: string; key: string }) =>
      apiFetch<{ data: { attachmentKeys: string[] } }>(
        `/tickets/${ticketId}/attachments?key=${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, { ticketId }) => {
      qc.invalidateQueries({ queryKey: ticketAttachmentsKey(ticketId) });
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
    },
  });
}

// ─── Unit history (immutable: create + read only) ───────────────────────────

export function useUnitHistory(unitId: string | undefined) {
  return useQuery({
    queryKey: unitHistoryKey(unitId ?? ""),
    queryFn: () => apiFetch<{ data: HistoryRow[] }>(`/units/${unitId}/history`),
    enabled: !!unitId,
  });
}

export function useQuickLog(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<QuickLogInput, "unitId">) =>
      apiFetch<{ data: { history: HistoryRow; ticketId: string } }>(`/units/${unitId}/history`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // Quick log may auto-create/attach to a ticket, so tickets stale too.
      qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryKey(unitId) });
      qc.invalidateQueries({ queryKey: unitHistoryAttachmentsKey(unitId) });
    },
  });
}

export function useUnitHistoryAttachmentUrls(unitId: string | undefined) {
  return useQuery({
    queryKey: unitHistoryAttachmentsKey(unitId ?? ""),
    queryFn: () =>
      apiFetch<{ data: AttachmentUrl[] }>(`/units/${unitId}/history/attachments/download-urls`),
    enabled: !!unitId,
  });
}

// ─── Sprints (flag-gated layer over the Tasks board) ─────────────────────────
// Membership is set via the EXISTING PATCH /tasks/:id (useSetTaskSprint), so a
// task↔sprint change invalidates BOTH the sprint summaries and the board.
// Spec 3 replaces Spec 1's velocity endpoint with /sprints/trends (cross-sprint
// trends) + /sprints/:id/burndown (within-sprint derived burndown).

export function useSprints(
  filters: ListSprintsQueryInput = {},
  options?: { enabled?: boolean },
) {
  const sanitized = sanitizeFilters(filters);
  return useQuery({
    queryKey: [...SPRINTS_KEY, sanitized],
    queryFn: () => apiFetch<{ data: SprintRow[] }>(`/sprints${toQueryString(sanitized)}`),
    // Two-arg from the start (§1.12): the board passes enabled:false while the
    // flag is OFF so /sprints is never fetched on the dark board.
    enabled: options?.enabled ?? true,
    placeholderData: (prev) => prev,
  });
}

export function useSprint(sprintId: string | undefined) {
  return useQuery({
    queryKey: [...SPRINTS_KEY, sprintId],
    queryFn: () => apiFetch<{ data: SprintRow }>(`/sprints/${sprintId}`),
    enabled: !!sprintId,
    placeholderData: (prev) => prev,
  });
}

/**
 * Cross-sprint trends (Spec 3 §5/§7) — REPLACES Spec 1's velocity endpoint.
 * `window` = the last N completed sprints (API default 8). Each point carries
 * completed (velocity), carried (carryover), and completionRate.
 */
export function useSprintTrends(window?: number) {
  // window is a number; sanitizeFilters keeps only string entries, so stringify
  // it explicitly into the querystring the .strict() z.coerce.number() accepts.
  const sanitized: Record<string, string> =
    window !== undefined ? { window: String(window) } : {};
  return useQuery({
    queryKey: [...SPRINTS_KEY, "trends", sanitized],
    queryFn: () =>
      apiFetch<{ data: SprintTrendPoint[] }>(`/sprints/trends${toQueryString(sanitized)}`),
    placeholderData: (prev) => prev,
  });
}

export function useCreateSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSprintInput) =>
      apiFetch<{ data: SprintRow }>("/sprints", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SPRINTS_KEY }),
  });
}

export function useUpdateSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, ...body }: UpdateSprintInput) =>
      apiFetch<{ data: SprintRow }>(`/sprints/${sprintId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SPRINTS_KEY }),
  });
}

export function useStartSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, ...body }: SprintLifecycleInput) =>
      apiFetch<{ data: SprintRow }>(`/sprints/${sprintId}/start`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SPRINTS_KEY }),
  });
}

export function useCloseSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, ...body }: SprintLifecycleInput) =>
      apiFetch<{ data: SprintRow }>(`/sprints/${sprintId}/close`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Close carries undone tasks back to Backlog AND freezes Done membership —
    // both the board and every sprint summary go stale.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SPRINTS_KEY });
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

export function useDeleteSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sprintId, updatedAt }: SprintLifecycleInput) =>
      apiFetch<{ data: { id: string } }>(`/sprints/${sprintId}`, {
        method: "DELETE",
        body: JSON.stringify({ updatedAt }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SPRINTS_KEY });
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

export function useSetTaskSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      ...body
    }: {
      taskId: string;
      updatedAt: string;
      sprintId: string | null;
    }) =>
      apiFetch<{ data: TaskRow }>(`/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    // Membership change moves a card between Backlog and a sprint — invalidate
    // the board AND the sprint summaries (committed/carried counts shift).
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
      qc.invalidateQueries({ queryKey: SPRINTS_KEY });
    },
  });
}
