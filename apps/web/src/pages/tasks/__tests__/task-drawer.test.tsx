import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks (mirrors listing-media-panel.test.tsx conventions — no msw) ────────

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
  getStoredUser: vi.fn(() => null),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { buildGoogleCalendarUrl } from "@/lib/google-calendar";
import { formatDateTimeMY } from "@/components/format";
import type { TaskRow } from "@/api/tasks";
import { TaskDrawer } from "../task-drawer";

const apiFetchMock = vi.mocked(apiFetch);
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

function setRole(role: string) {
  mockUseAuth.mockReturnValue({
    user: { id: "u-admin", fullName: "Ops Admin", email: "ops@example.com", role, orgId: "org-1" },
    isAuthenticated: true,
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
  });
}

function makeTask(over: Partial<TaskRow>): TaskRow {
  return {
    id: "task-7",
    title: "Repaint corridor",
    description: null,
    status: "pool",
    priority: "medium",
    category: null,
    sortOrder: null,
    attachmentKeys: [],
    assignee: null,
    relatedUnit: null,
    ticketId: null,
    sprintId: null,
    dueOn: null,
    startedAt: null,
    completedAt: null,
    assignedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

const createdTask = makeTask({ id: "task-new", title: "Buy bulbs" });

function stubApi() {
  apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path.startsWith("/users")) {
      return Promise.resolve({
        data: [{ id: "u-1", fullName: "Jane Doe", status: "active", role: "editor", email: "j@x.com" }],
      }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/tasks" && options?.method === "POST") {
      return Promise.resolve({ data: createdTask }) as ReturnType<typeof apiFetch>;
    }
    if (path.includes("/status") && options?.method === "PATCH") {
      return Promise.resolve({
        data: makeTask({ status: "in_progress", updatedAt: "2026-06-11T00:00:00.000Z" }),
      }) as ReturnType<typeof apiFetch>;
    }
    if (path.includes("/attachments/download-urls")) {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
  });
}

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubApi();
});

describe("TaskDrawer — create", () => {
  it("requires a title before mutating", async () => {
    setRole("editor");
    render(withQuery(<TaskDrawer open mode="create" onClose={vi.fn()} />));

    // Submit the form directly — jsdom's constraint validation blocks the
    // click path on the empty `required` input before our validation runs;
    // in a real browser the drawer's per-field error is the visible layer.
    const form = screen.getByRole("button", { name: "Create task" }).closest("form")!;
    fireEvent.submit(form);

    expect(await screen.findByText("Title is required.")).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.find((c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST"),
    ).toBeUndefined();
  });

  it("POSTs /tasks and switches to edit mode (Callout appears, drawer stays open)", async () => {
    setRole("editor");
    render(withQuery(<TaskDrawer open mode="create" onClose={vi.fn()} />));

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Buy bulbs" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    // Stays open and flips to edit mode with an info Callout.
    expect(
      await screen.findByText("Task created — add attachments below or close."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();

    const call = apiFetchMock.mock.calls.find(
      (c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
      title: "Buy bulbs",
      priority: "medium",
      assigneeUserId: null,
      relatedUnitId: null,
      dueOn: null,
    });
  });
});

describe("TaskDrawer — edit", () => {
  it("status Segmented fires PATCH /tasks/:id/status with the concurrency token", async () => {
    setRole("editor");
    const task = makeTask({});
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    const group = screen.getByRole("radiogroup", { name: "Status" });
    fireEvent.click(within(group).getByRole("radio", { name: "In progress" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/task-7/status",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/task-7/status")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      status: "in_progress",
      updatedAt: task.updatedAt,
    });
  });

  it("lets a done + ticket-linked task be pulled out of Done (PATCH fires, reopen hint shown)", async () => {
    setRole("editor");
    // Pull-back reopens the linked ticket server-side; the control stays live
    // and the hint names the consequence.
    const task = makeTask({ status: "done", ticketId: "ticket-1" });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    const group = screen.getByRole("radiogroup", { name: "Status" });
    expect(group).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Pulling it out of Done reopens the linked ticket."),
    ).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("radio", { name: "In progress" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/task-7/status",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/task-7/status")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      status: "in_progress",
      updatedAt: task.updatedAt,
    });
  });

  it("does NOT lock the Status control for a done task with no linked ticket", () => {
    setRole("editor");
    const task = makeTask({ status: "done", ticketId: null });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    const group = screen.getByRole("radiogroup", { name: "Status" });
    expect(group).not.toHaveAttribute("aria-disabled");
  });

  it("hides Archive from editors", () => {
    setRole("editor");
    render(withQuery(<TaskDrawer open mode="edit" task={makeTask({})} onClose={vi.fn()} />));

    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("shows 'Open in Google Calendar' in edit mode when dueOn is set", () => {
    setRole("editor");
    render(
      withQuery(
        <TaskDrawer
          open
          mode="edit"
          task={makeTask({ dueOn: "2026-07-01T00:00:00.000Z" })}
          onClose={vi.fn()}
        />,
      ),
    );
    expect(
      screen.getByRole("button", { name: "Open in Google Calendar" }),
    ).toBeInTheDocument();
  });

  it("hides the calendar button in edit mode when the task has no dueOn", () => {
    setRole("editor");
    render(
      withQuery(<TaskDrawer open mode="edit" task={makeTask({ dueOn: null })} onClose={vi.fn()} />),
    );
    expect(screen.queryByRole("button", { name: "Open in Google Calendar" })).toBeNull();
  });

  it("clicking the calendar button opens buildGoogleCalendarUrl output in a new tab", () => {
    setRole("editor");
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const task = makeTask({ dueOn: "2026-07-01T00:00:00.000Z" });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    fireEvent.click(screen.getByRole("button", { name: "Open in Google Calendar" }));

    // The drawer re-normalizes the date-input value (yyyy-mm-dd) back to a
    // Z-anchored ISO datetime before building the link.
    expect(openSpy).toHaveBeenCalledWith(
      buildGoogleCalendarUrl({ title: task.title, dueOn: "2026-07-01T00:00:00.000Z" }),
      "_blank",
      "noopener",
    );
    openSpy.mockRestore();
  });

  it("shows Archive to managers (and Restore on archived tasks)", () => {
    setRole("manager");
    const { unmount } = render(
      withQuery(<TaskDrawer open mode="edit" task={makeTask({})} onClose={vi.fn()} />),
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    unmount();

    render(
      withQuery(
        <TaskDrawer open mode="edit" task={makeTask({ status: "archived" })} onClose={vi.fn()} />,
      ),
    );
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("shows the Created timestamp for an edited task", () => {
    setRole("editor");
    const task = makeTask({ createdAt: "2026-06-01T01:30:00.000Z" });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    expect(
      screen.getByText(`Created ${formatDateTimeMY(task.createdAt)}`),
    ).toBeInTheDocument();
    // Companion regression check (assignedAt is null via the makeTask default):
    // the Assigned line must stay hidden — pre-existing guard, not this cycle's delta.
    expect(screen.queryByText(/^Assigned /)).toBeNull();
  });

  it("shows created and assigned timestamps", () => {
    setRole("editor");
    const task = makeTask({
      assignee: { id: "u-9", fullName: "Jane Doe", photoUrl: null },
      assignedAt: "2026-06-05T04:15:00.000Z",
      createdAt: "2026-06-01T01:30:00.000Z",
    });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    expect(
      screen.getByText(`Created ${formatDateTimeMY(task.createdAt)}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Assigned Jane Doe on ${formatDateTimeMY(task.assignedAt)}`),
    ).toBeInTheDocument();
  });

  it("falls back to 'Assigned on <date>' (no name) when assignedAt is set but assignee is null", () => {
    setRole("editor");
    const task = makeTask({ assignee: null, assignedAt: "2026-06-05T04:15:00.000Z" });
    render(withQuery(<TaskDrawer open mode="edit" task={task} onClose={vi.fn()} />));

    expect(
      screen.getByText(`Assigned on ${formatDateTimeMY(task.assignedAt)}`),
    ).toBeInTheDocument();
  });
});
