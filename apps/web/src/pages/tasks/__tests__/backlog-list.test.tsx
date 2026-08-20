import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import type { SprintRow, TaskRow } from "@/api/tasks";
import { BacklogList } from "../backlog-list";
import { useAuth } from "@/lib/auth";
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

const apiFetchMock = vi.mocked(apiFetch);

function makeTask(over: Partial<TaskRow>): TaskRow {
  return {
    id: "t-x",
    title: "Task",
    description: null,
    status: "pool",
    priority: "medium",
    category: null,
    sortOrder: 0,
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
const tHigh = makeTask({ id: "t-high", title: "Urgent fix", priority: "high" });
const tLow = makeTask({ id: "t-low", title: "Nice to have", priority: "low" });

function makeSprint(over: Partial<SprintRow>): SprintRow {
  return {
    id: "s-x",
    seq: 1,
    name: null,
    goal: null,
    status: "active",
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
const plannedSprint = makeSprint({ id: "s-plan", seq: 5, status: "planned", name: "Polish" });

function renderList(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: "u", fullName: "A", email: "a@x.com", role: "manager" } });
  apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
    if (options?.method === "PATCH") {
      return Promise.resolve({ data: makeTask({ id: "t-high" }) }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/tasks")) {
      return Promise.resolve({ data: [tLow, tHigh] }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
  });
});

describe("BacklogList", () => {
  it("requests sprintId=null, renders the §1.12 root + rows, and ranks high above low", async () => {
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    await screen.findByText("Urgent fix");
    expect(apiFetchMock).toHaveBeenCalledWith("/tasks?sprintId=null");

    // §1.12 root + per-row data attributes.
    expect(screen.getByTestId("backlog-list")).toBeInTheDocument();
    const rows = document.querySelectorAll("[data-backlog-row]");
    expect(rows).toHaveLength(2);
    // High-priority row sorts before low (data-task-id reflects order).
    expect(rows[0]).toHaveAttribute("data-task-id", "t-high");
    expect(rows[1]).toHaveAttribute("data-task-id", "t-low");
    expect(rows[0]).toHaveTextContent("Urgent fix");
  });

  it("forwards assignee + single-priority filters to the query and narrows multi-priority client-side", async () => {
    // A single real category is forwarded server-side; the returned task carries
    // that category so it survives the (idempotent) client-side narrowByCategory.
    apiFetchMock.mockImplementation((path: string) =>
      (path.startsWith("/tasks")
        ? Promise.resolve({ data: [makeTask({ id: "t-high", title: "Urgent fix", priority: "high", category: "plumbing" })] })
        : Promise.resolve({ data: [] })) as ReturnType<typeof apiFetch>);
    renderList(
      <BacklogList
        targetSprints={[activeSprint]}
        onOpenTask={vi.fn()}
        filters={{ priorities: ["high"], assigneeUserId: "u-7", categories: ["plumbing"], dueChip: null }}
      />,
    );
    await screen.findByText("Urgent fix");
    // Single priority + assignee + category go server-side (order: sanitized object insertion).
    const taskCall = apiFetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).startsWith("/tasks?"),
    )!;
    const url = taskCall[0] as string;
    expect(url).toContain("sprintId=null");
    expect(url).toContain("priority=high");
    expect(url).toContain("assigneeUserId=u-7");
    expect(url).toContain("category=plumbing");
  });

  it("per-row 'Add to sprint' PATCHes that one task to the picked target", async () => {
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    await screen.findByText("Urgent fix");

    // No checkbox needed for the per-row affordance.
    fireEvent.click(screen.getByTestId("backlog-add-t-high"));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/t-high",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/t-high")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      updatedAt: tHigh.updatedAt,
      sprintId: "s-active",
    });
  });

  it("bulk 'Add N' PATCHes every checked task to the picked target", async () => {
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    await screen.findByText("Urgent fix");

    fireEvent.click(screen.getByTestId("backlog-check-t-high"));
    fireEvent.click(screen.getByTestId("backlog-check-t-low"));
    // Bulk button reflects the selected count.
    expect(screen.getByTestId("backlog-add-bulk")).toHaveTextContent("Add 2");
    fireEvent.click(screen.getByTestId("backlog-add-bulk"));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/t-high",
        expect.objectContaining({ method: "PATCH" }),
      );
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/t-low",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("target picker lists active AND planned sprints; choosing planned targets it (O3)", async () => {
    renderList(<BacklogList targetSprints={[activeSprint, plannedSprint]} onOpenTask={vi.fn()} />);
    await screen.findByText("Urgent fix");

    const picker = screen.getByTestId("backlog-target-picker") as HTMLSelectElement;
    // Both an active and a planned sprint are selectable targets.
    const optionValues = Array.from(picker.options).map((o) => o.value);
    expect(optionValues).toEqual(["s-active", "s-plan"]);

    // Pick the planned sprint, then add a row → PATCH targets s-plan.
    fireEvent.change(picker, { target: { value: "s-plan" } });
    fireEvent.click(screen.getByTestId("backlog-add-t-high"));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tasks/t-high",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/tasks/t-high")!;
    expect(JSON.parse((call[1] as RequestInit).body as string).sprintId).toBe("s-plan");
  });

  it("hides the add affordances when there are no target sprints", async () => {
    renderList(<BacklogList targetSprints={[]} onOpenTask={vi.fn()} />);
    await screen.findByText("Urgent fix");
    expect(screen.queryByTestId("backlog-add-bulk")).toBeNull();
    expect(screen.queryByTestId("backlog-add-t-high")).toBeNull();
    expect(screen.queryByTestId("backlog-target-picker")).toBeNull();
  });

  it("renders a unit-linked row title-led: title is the semibold header, unit shown as a chip below", async () => {
    const tUnit = makeTask({
      id: "t-unit", title: "Fix aircon leak", ticketId: "tk-1",
      relatedUnit: { id: "u1", unitCode: "A-10-04", propertyName: "KAEN Residence" },
    });
    apiFetchMock.mockImplementation((path: string) =>
      (path.startsWith("/tasks")
        ? Promise.resolve({ data: [tUnit] })
        : Promise.resolve({ data: [] })) as ReturnType<typeof apiFetch>);
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    const header = await screen.findByText("Fix aircon leak");
    expect(header).toHaveClass("font-semibold");
    // Unit is present as the chip, NOT as the header.
    expect(screen.getByText("A-10-04 · KAEN Residence")).toBeInTheDocument();
    expect(screen.getByText("A-10-04 · KAEN Residence")).not.toHaveClass("font-semibold");
  });

  it("renders a unit-less row title-led: title is the anchor, category shown once (pill only)", async () => {
    const tNoUnit = makeTask({ id: "t-nou", title: "Buy printer paper", category: "General", relatedUnit: null, ticketId: null });
    apiFetchMock.mockImplementation((path: string) =>
      (path.startsWith("/tasks")
        ? Promise.resolve({ data: [tNoUnit] })
        : Promise.resolve({ data: [] })) as ReturnType<typeof apiFetch>);
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    const anchor = await screen.findByText("Buy printer paper");
    expect(anchor).toHaveClass("font-semibold");
    // category appears exactly once — as the right-column pill, not also as a subline
    expect(screen.getAllByText("General")).toHaveLength(1);
  });

  it("manager deletes a unit-linked backlog task via the row menu; confirm names the ticket", async () => {
    const tUnit = makeTask({
      id: "t-unit", title: "Fix aircon leak", ticketId: "tk-1",
      relatedUnit: { id: "u1", unitCode: "A-10-04", propertyName: "KAEN Residence" },
    });
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return Promise.resolve({ data: { id: "t-unit" } }) as ReturnType<typeof apiFetch>;
      if (path.startsWith("/tasks")) return Promise.resolve({ data: [tUnit] }) as ReturnType<typeof apiFetch>;
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    });
    renderList(<BacklogList targetSprints={[activeSprint]} onOpenTask={vi.fn()} />);
    await screen.findByText("Fix aircon leak");
    fireEvent.click(screen.getByTestId("task-menu-t-unit"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/ticket for A-10-04 · KAEN Residence/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/tasks/t-unit", expect.objectContaining({ method: "DELETE" })),
    );
  });
});
