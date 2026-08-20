import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
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

// recharts measures 0×0 in jsdom — stub ResponsiveContainer so the flag-ON
// the Backlog-tab sprint trends chart mounts without throwing. The flag-OFF board
// never renders a chart, so this is inert for the existing cases above.
vi.mock("recharts", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 280 }}>{children}</div>
    ),
  };
});

// The page reads VITE_ENABLE_PHASE2_SPRINTS into a MODULE-LEVEL const at import
// time. The board-view + archived suites below are the FLAG-OFF regression cases
// (original kanban board, lanes-as-default) and assume the flag is unset/false.
// Local apps/web/.env sets it "true" for dev, which vitest loads — so without
// this the static import below captures true, the board defaults to the backlog
// tab, the lanes never render, and those suites break. Pin it false BEFORE the
// import (the flag-ON suite re-stubs "true" + resetModules for its own cases).
vi.hoisted(() => {
  vi.stubEnv("VITE_ENABLE_PHASE2_SPRINTS", "false");
});

import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import type { SprintRow, TaskRow } from "@/api/tasks";
import TasksBoardPage from "../tasks-board-page";
import { computeDropPosition } from "../tasks-board-dnd";

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

// ── Fixtures (dueOn relative to the local calendar day, matching the page) ──

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const dayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const overdueIso = new Date(dayStartMs - 2 * DAY).toISOString();
const todayIso = new Date(dayStartMs + 12 * 60 * 60 * 1000).toISOString();
const weekIso = new Date(dayStartMs + 3 * DAY + 12 * 60 * 60 * 1000).toISOString();

function makeTask(over: Partial<TaskRow>): TaskRow {
  return {
    id: "task-x",
    title: "A task",
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

const task1 = makeTask({
  id: "task-1",
  title: "Fix leaking sink",
  status: "pool",
  priority: "high",
  dueOn: overdueIso,
  attachmentKeys: ["k1"],
  relatedUnit: { id: "unit-1", unitCode: "A-3-2", propertyName: "Vista Residence" },
  assignee: { id: "u-1", fullName: "Jane Doe", photoUrl: null },
});
const task2 = makeTask({
  id: "task-2",
  title: "Service aircond",
  status: "in_progress",
  priority: "medium",
  dueOn: todayIso,
});
// Done + week-due: must be EXCLUDED from every KPI bucket and chip filter —
// the strip measures actionable load, not completed work.
const task3 = makeTask({
  id: "task-3",
  title: "Replace mailbox lock",
  status: "done",
  priority: "low",
  dueOn: weekIso,
  completedAt: new Date().toISOString(),
});
// Non-done week-due fixture — the positive "due this week" count. Status pool
// (not todo) so the drag test's empty lane-todo position-0 assertion holds.
const task4 = makeTask({
  id: "task-4",
  title: "Inspect balcony",
  status: "pool",
  priority: "low",
  dueOn: weekIso,
});
const archivedTask = makeTask({
  id: "task-9",
  title: "Old chore",
  status: "archived",
  updatedAt: "2026-06-01T00:00:00.000Z",
});

function stubApi() {
  apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
    if (path.startsWith("/users")) {
      return Promise.resolve({
        data: [
          { id: "u-1", fullName: "Jane Doe", status: "active", role: "editor", email: "j@x.com" },
          { id: "u-2", fullName: "Gone Guy", status: "inactive", role: "editor", email: "g@x.com" },
        ],
      }) as ReturnType<typeof apiFetch>;
    }
    if (options?.method === "PATCH" || options?.method === "POST") {
      return Promise.resolve({ data: makeTask({ id: "task-1" }) }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/tasks?status=archived") {
      return Promise.resolve({ data: [archivedTask] }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/tasks")) {
      return Promise.resolve({ data: [task1, task2, task3, task4] }) as ReturnType<
        typeof apiFetch
      >;
    }
    return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage(entries: string[] = ["/tasks"]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries}>
        <TasksBoardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubApi();
});

describe("TasksBoardPage — board view", () => {
  it("renders 4 lanes with cards and correct due-date KPI counts; chips filter cards", async () => {
    setRole("editor");
    renderPage();

    expect(await screen.findByText("Fix leaking sink")).toBeInTheDocument();
    for (const status of ["pool", "todo", "in_progress", "done"]) {
      expect(screen.getByTestId(`lane-${status}`)).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId("lane-pool")).getByText("Fix leaking sink"),
    ).toBeInTheDocument();

    // KPI chips computed from the fixture dueOns: 1 overdue / 1 today / 1 this
    // week. task-3 (done, week-due) is EXCLUDED — were it counted, the week
    // chip would read "2 due this week".
    const overdueChip = screen.getByRole("button", { name: "1 overdue" });
    expect(overdueChip).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 due today" })).toBeInTheDocument();
    const weekChip = screen.getByRole("button", { name: "1 due this week" });
    expect(weekChip).toBeInTheDocument();

    // Toggling the overdue chip filters the rendered cards client-side.
    fireEvent.click(overdueChip);
    expect(overdueChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Fix leaking sink")).toBeInTheDocument();
    expect(screen.queryByText("Service aircond")).toBeNull();
    expect(screen.queryByText("Replace mailbox lock")).toBeNull();
    expect(screen.queryByText("Inspect balcony")).toBeNull();

    // Toggling again restores the board.
    fireEvent.click(overdueChip);
    expect(screen.getByText("Service aircond")).toBeInTheDocument();

    // Week chip: the non-done week-due card shows; the done week-due card is
    // excluded from the filter exactly as it is from the count.
    fireEvent.click(weekChip);
    expect(weekChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Inspect balcony")).toBeInTheDocument();
    expect(screen.queryByText("Replace mailbox lock")).toBeNull();
    expect(screen.queryByText("Fix leaking sink")).toBeNull();

    // Toggle off restores the full board again.
    fireEvent.click(weekChip);
    expect(screen.getByText("Replace mailbox lock")).toBeInTheDocument();
  });

  it("onDrop PATCHes /tasks/:id/status with {status, position, updatedAt}", async () => {
    setRole("editor");
    renderPage();
    await screen.findByText("Fix leaking sink");

    // DataTransfer stub — jsdom has no DragEvent constructor with dataTransfer.
    const getData = vi.fn(() => "task-1");
    fireEvent.drop(screen.getByTestId("lane-todo"), {
      dataTransfer: { getData },
    });

    expect(getData).toHaveBeenCalledWith("text/task-id");
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/task-1/status",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/task-1/status")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      status: "todo",
      position: 0, // empty target lane → append at 0
      updatedAt: task1.updatedAt,
    });
  });

  it("OMITS position from the move payload when a client-side filter is active", async () => {
    setRole("editor");
    renderPage();
    await screen.findByText("Fix leaking sink");

    // Activate the overdue chip — the rendered lanes are now a subset of the
    // true server-side lanes, so a computed position would be wrong.
    fireEvent.click(screen.getByRole("button", { name: "1 overdue" }));

    fireEvent.drop(screen.getByTestId("lane-todo"), {
      dataTransfer: { getData: vi.fn(() => "task-1") },
    });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/task-1/status",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/task-1/status")!;
    // Exact equality proves `position` was omitted — server appends instead.
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      status: "todo",
      updatedAt: task1.updatedAt,
    });
  });

  it("computes KPI counts from the priority-narrowed list when 2+ priorities are selected", async () => {
    setRole("editor");
    renderPage();
    await screen.findByText("Fix leaking sink");

    // Select High + Medium (2 selections stay client-side — no refetch).
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Medium" }));

    // Low-priority cards drop out of BOTH the lanes and the KPI counts:
    // task-4 (low, week-due) no longer counts, so "0 due this week".
    expect(screen.getByRole("button", { name: "1 overdue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 due today" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0 due this week" })).toBeInTheDocument();
    expect(screen.queryByText("Inspect balcony")).toBeNull();
  });
});

describe("computeDropPosition", () => {
  const rects = [
    { id: "A", midY: 10 },
    { id: "B", midY: 30 },
    { id: "C", midY: 50 },
  ];

  it("same-lane downward drag excludes the dragged card (A below B → 1, not 2)", () => {
    // clientY 40 sits below B's midpoint and above C's. With A excluded the
    // lane the server splices into is [B, C] — A belongs at index 1.
    expect(computeDropPosition(rects, 40, "A")).toBe(1);
  });

  it("upward drag is unchanged (C above B's midpoint → 1)", () => {
    expect(computeDropPosition(rects, 20, "C")).toBe(1);
  });

  it("empty lane → 0", () => {
    expect(computeDropPosition([], 0, "X")).toBe(0);
  });

  it("cross-lane drop below all cards appends", () => {
    expect(computeDropPosition(rects, 100, "Z")).toBe(3);
  });
});

describe("TasksBoardPage — archived view", () => {
  it("renders archived rows and Restore fires POST /tasks/:id/restore (manager)", async () => {
    setRole("manager");
    renderPage(["/tasks?view=archived"]);

    expect(await screen.findByText("Old chore")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/task-9/restore",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/task-9/restore")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      updatedAt: archivedTask.updatedAt,
    });
  });

  it("hides the Restore button from editors", async () => {
    setRole("editor");
    renderPage(["/tasks?view=archived"]);

    expect(await screen.findByText("Old chore")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});

// ── Sprint layer (VITE_ENABLE_PHASE2_SPRINTS = "true") ───────────────────────
// The page reads the flag into a MODULE-LEVEL const at import time (mirrors
// api/payments.ts). To exercise the flag-ON branch we stubEnv THEN resetModules
// and dynamically re-import the page so the const re-evaluates as true. The
// existing cases above run untouched with the flag unset (const === false), which
// is the byte-for-byte flag-OFF regression guarantee.

function makeSprint(over: Partial<SprintRow>): SprintRow {
  return {
    id: "s-x",
    seq: 1,
    name: null,
    goal: null,
    status: "planned",
    startsOn: null,
    endsOn: null,
    startedAt: null,
    completedAt: null,
    summary: { committed: 0, completed: 0, carried: 0, completionPct: 0 },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

const activeSprint = makeSprint({ id: "s-active", seq: 4, status: "active" });
const pastSprint = makeSprint({
  id: "s-past",
  seq: 3,
  status: "completed",
  summary: { committed: 5, completed: 4, carried: 1, completionPct: 80 },
});
const sprintTask = makeTask({
  id: "t-in",
  title: "In sprint",
  sprintId: "s-active",
  relatedUnit: { id: "unit-1", unitCode: "A-3-2", propertyName: "Vista Residence" },
});
const backlogTask = makeTask({ id: "t-back", title: "Backlog item", sprintId: null });

describe("TasksBoardPage — sprint layer (flag ON)", () => {
  // Re-acquired from the freshly reset module graph each test so assertions read
  // the SAME apiFetch mock instance the dynamically-imported page calls.
  let apiFetch: ReturnType<typeof vi.fn>;
  let SprintBoardPage: typeof import("../tasks-board-page").default;

  function stubSprintApi() {
    apiFetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path.startsWith("/users")) {
        return Promise.resolve({ data: [] });
      }
      if (path === "/sprints") {
        return Promise.resolve({ data: [activeSprint, pastSprint] });
      }
      if (path.startsWith("/sprints/trends")) {
        return Promise.resolve({ data: [] });
      }
      if (options?.method === "PATCH" || options?.method === "POST") {
        return Promise.resolve({ data: makeTask({ id: "t-in" }) });
      }
      if (path.startsWith("/tasks") && /[?&]sprintId=null/.test(path)) {
        return Promise.resolve({ data: [backlogTask] });
      }
      if (path.startsWith("/tasks")) {
        return Promise.resolve({ data: [sprintTask] });
      }
      return Promise.resolve({ data: [] });
    });
  }

  async function setup(role = "manager") {
    vi.resetModules();
    vi.stubEnv("VITE_ENABLE_PHASE2_SPRINTS", "true");
    // Re-import the mocked modules from the reset graph + the page under test.
    const apiClient = await import("@/lib/api-client");
    const auth = await import("@/lib/auth");
    apiFetch = vi.mocked(apiClient.apiFetch) as ReturnType<typeof vi.fn>;
    (auth.useAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { id: "u-admin", fullName: "Ops Admin", email: "ops@example.com", role, orgId: "org-1" },
      isAuthenticated: true,
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
    });
    stubSprintApi();
    SprintBoardPage = (await import("../tasks-board-page")).default;
  }

  function renderSprintPage(entries: string[] = ["/tasks"]) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={entries}>
          <SprintBoardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("renders the selector with Backlog + sprint tabs and defaults to the active sprint", async () => {
    await setup();
    renderSprintPage();

    expect(await screen.findByTestId("sprint-selector")).toBeInTheDocument();
    expect(await screen.findByTestId("sprint-tab-backlog")).toBeInTheDocument();
    expect(await screen.findByTestId("sprint-tab-s-active")).toBeInTheDocument();
    // Completed sprints live inside the Sprint ▾ picker (not a top-level tab).
    expect(screen.queryByTestId("sprint-tab-s-past")).toBeNull();
    expect(await screen.findByTestId("sprint-picker-trigger")).toBeInTheDocument();
    // Default selection = the active sprint, and its scoped task is on the board.
    expect(await screen.findByTestId("sprint-tab-s-active")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("In sprint")).toBeInTheDocument();
  });

  it("selecting a sprint tab makes the /tasks request carry sprintId=<id>", async () => {
    await setup();
    renderSprintPage();
    await screen.findByText("In sprint");

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((c) => String(c[0]) === "/tasks?sprintId=s-active"),
      ).toBe(true),
    );
  });

  it("the Backlog tab swaps the lanes for the backlog list (sprintId=null fetch)", async () => {
    await setup();
    renderSprintPage();
    fireEvent.click(await screen.findByTestId("sprint-tab-backlog"));

    expect(await screen.findByTestId("backlog-list")).toBeInTheDocument();
    expect(await screen.findByText("Backlog item")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some((c) => String(c[0]) === "/tasks?sprintId=null"),
      ).toBe(true),
    );
  });

  it("New Task on the active sprint seeds sprintId in the POST /tasks body", async () => {
    await setup();
    renderSprintPage();
    await screen.findByTestId("sprint-tab-s-active");

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    fireEvent.change(await screen.findByPlaceholderText(/replace aircond filter/i), {
      target: { value: "Seeded into sprint" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some(
          (c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    const createCall = apiFetch.mock.calls.find(
      (c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse((createCall[1] as RequestInit).body as string).sprintId).toBe("s-active");
  });

  it("New Task on the Backlog tab POSTs /tasks with NO sprintId", async () => {
    await setup();
    renderSprintPage();
    fireEvent.click(await screen.findByTestId("sprint-tab-backlog"));
    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    fireEvent.change(await screen.findByPlaceholderText(/replace aircond filter/i), {
      target: { value: "Backlog-born task" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some(
          (c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
    const createCall = apiFetch.mock.calls.find(
      (c) => c[0] === "/tasks" && (c[1] as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse((createCall[1] as RequestInit).body as string).sprintId ?? null).toBeNull();
  });

  it("per-card 'Move to Backlog' on the active tab PATCHes /tasks/:id with sprintId:null", async () => {
    await setup();
    renderSprintPage();
    await screen.findByText("In sprint");

    fireEvent.click(screen.getByTestId("task-menu-t-in"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Backlog" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/tasks/t-in",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const call = apiFetch.mock.calls.find((c) => c[0] === "/tasks/t-in")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      updatedAt: sprintTask.updatedAt,
      sprintId: null,
    });
  });

  it("a completed sprint renders read-only: no New Task, no Move to Backlog", async () => {
    await setup();
    renderSprintPage();
    // Completed sprints live inside the Sprint ▾ picker — open it then click the item.
    fireEvent.click(await screen.findByTestId("sprint-picker-trigger"));
    fireEvent.click(await screen.findByTestId("sprint-picker-item-s-past"));

    // Frozen: no New Task, no per-card Move to Backlog (summary card was removed).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /new task/i })).toBeNull(),
    );
    fireEvent.click(screen.getByTestId("task-menu-t-in"));
    expect(screen.queryByRole("menuitem", { name: "Move to Backlog" })).toBeNull();
  });

  it("renders sprint cards title-led with a unit chip and a ⋯ action menu", async () => {
    await setup();
    renderSprintPage();
    // The rendered active-sprint card is fixture `sprintTask` (id `t-in`,
    // title "In sprint") carrying unit A-3-2 · Vista Residence. Its TITLE is the
    // semibold header; the unit is the chip beneath (not semibold).
    const header = await screen.findByText("In sprint");
    expect(header).toHaveClass("font-semibold");
    expect(screen.getByText("A-3-2 · Vista Residence")).toBeInTheDocument();
    expect(screen.getByText("A-3-2 · Vista Residence")).not.toHaveClass("font-semibold");
    expect(screen.getByTestId("task-menu-t-in")).toBeInTheDocument();
  });

  it("the manage menu is manager-gated (hidden from editors)", async () => {
    await setup("editor");
    renderSprintPage();

    expect(await screen.findByTestId("sprint-selector")).toBeInTheDocument();
    expect(screen.queryByTestId("sprint-manage-menu")).toBeNull();
  });

  it("manager sees the manage menu trigger", async () => {
    await setup("manager");
    renderSprintPage();

    expect(await screen.findByTestId("sprint-manage-menu")).toBeInTheDocument();
  });
});
