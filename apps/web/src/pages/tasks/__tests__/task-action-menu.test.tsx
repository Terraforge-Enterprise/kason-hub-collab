import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import type { TaskRow } from "@/api/tasks";
import { TaskActionMenu } from "../task-action-menu";

const apiFetchMock = vi.mocked(apiFetch);
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;
function setRole(role: string) {
  mockUseAuth.mockReturnValue({ user: { id: "u", fullName: "A", email: "a@x.com", role } });
}

function makeTask(over: Partial<TaskRow>): TaskRow {
  return {
    id: "t-1", title: "Fix aircon leak", description: null, status: "pool",
    priority: "high", category: "Electricity", sortOrder: 0, attachmentKeys: [],
    assignee: null, relatedUnit: null, ticketId: null, sprintId: null,
    dueOn: null, startedAt: null, completedAt: null, assignedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  };
}

function renderMenu(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ data: { id: "t-1" } } as never);
});

describe("TaskActionMenu", () => {
  it("manager sees Edit + Archive + Delete; Edit fires onEdit", () => {
    setRole("manager");
    const onEdit = vi.fn();
    renderMenu(<TaskActionMenu task={makeTask({})} onEdit={onEdit} />);
    fireEvent.click(screen.getByTestId("task-menu-t-1"));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
  });

  it("operator sees Edit but NOT Archive/Delete", () => {
    setRole("editor");
    renderMenu(<TaskActionMenu task={makeTask({})} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-1"));
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("shows Move to Backlog only when the handler is passed and fires it", () => {
    setRole("manager");
    const onMoveToBacklog = vi.fn();
    renderMenu(<TaskActionMenu task={makeTask({})} onEdit={vi.fn()} onMoveToBacklog={onMoveToBacklog} />);
    fireEvent.click(screen.getByTestId("task-menu-t-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Backlog" }));
    expect(onMoveToBacklog).toHaveBeenCalled();
  });

  it("omits Move to Backlog when no handler is passed", () => {
    setRole("manager");
    renderMenu(<TaskActionMenu task={makeTask({})} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-1"));
    expect(screen.queryByRole("menuitem", { name: "Move to Backlog" })).toBeNull();
  });

  it("Delete on a UNIT-LINKED task warns about the ticket, then DELETEs", async () => {
    setRole("manager");
    const task = makeTask({
      id: "t-u", ticketId: "tk-9",
      relatedUnit: { id: "u1", unitCode: "A-10-04", propertyName: "KAEN Residence" },
    });
    renderMenu(<TaskActionMenu task={task} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-u"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/ticket for A-10-04 · KAEN Residence/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/tasks/t-u", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("Delete on a PURE task uses the generic confirm (no ticket mention)", async () => {
    setRole("manager");
    renderMenu(<TaskActionMenu task={makeTask({ id: "t-p" })} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-p"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText(/ticket/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/tasks/t-p", expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("Archive calls the archive mutation on confirm", async () => {
    setRole("manager");
    renderMenu(<TaskActionMenu task={makeTask({ id: "t-a" })} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-a"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/tasks/t-a/archive", expect.objectContaining({ method: "POST" })),
    );
  });

  it("admin also sees Archive + Delete", () => {
    setRole("admin");
    renderMenu(<TaskActionMenu task={makeTask({})} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-menu-t-1"));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});
