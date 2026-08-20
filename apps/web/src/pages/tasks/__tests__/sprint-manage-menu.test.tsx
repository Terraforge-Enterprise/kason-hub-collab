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
import type { SprintRow } from "@/api/tasks";
import { SprintManageMenu } from "../sprint-manage-menu";

const apiFetchMock = vi.mocked(apiFetch);
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;
function setRole(role: string) {
  mockUseAuth.mockReturnValue({ user: { id: "u", fullName: "A", email: "a@x.com", role } });
}

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
const active = makeSprint({
  id: "s-active",
  seq: 4,
  status: "active",
  summary: { committed: 5, completed: 3, carried: 2, completionPct: 60 },
});
const planned = makeSprint({ id: "s-plan", seq: 5, status: "planned" });

function renderMenu(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ data: active } as never);
});

describe("SprintManageMenu", () => {
  it("renders nothing for editors", () => {
    setRole("editor");
    renderMenu(
      <SprintManageMenu
        sprints={[active]}
        selected="s-active"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /manage/i })).toBeNull();
  });

  it("manager: trigger carries the §1.12 testid and New Sprint fires onNew", () => {
    setRole("manager");
    const onNew = vi.fn();
    renderMenu(
      <SprintManageMenu
        sprints={[active, planned]}
        selected="s-plan"
        onNew={onNew}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    // §1.12: trigger testid + accessible name both resolve to the same button.
    expect(screen.getByTestId("sprint-manage-menu")).toBe(
      screen.getByRole("button", { name: /manage/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    fireEvent.click(screen.getByTestId("sprint-action-new"));
    expect(onNew).toHaveBeenCalled();
  });

  it("manager: Start on a planned sprint POSTs /sprints/:id/start", async () => {
    setRole("manager");
    renderMenu(
      <SprintManageMenu
        sprints={[planned]}
        selected="s-plan"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start sprint" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/sprints/s-plan/start",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("manager: Close on the active sprint shows a committed/completed/carried preview then POSTs close", async () => {
    setRole("manager");
    renderMenu(
      <SprintManageMenu
        sprints={[active]}
        selected="s-active"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close sprint" }));

    const dialog = await screen.findByRole("alertdialog");
    // Preview surfaces the live summary numbers before the irreversible close.
    expect(within(dialog).getByText(/3 completed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 carried/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close sprint" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/sprints/s-active/close",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("manager: Close is hidden when the SELECTED sprint is planned even though another is active", () => {
    setRole("manager");
    renderMenu(
      <SprintManageMenu
        sprints={[active, planned]}
        selected="s-plan"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    // Close acts on the selected sprint; s-plan is planned → no Close item.
    expect(screen.queryByTestId("sprint-action-close")).toBeNull();
    // Start IS offered for the selected planned sprint.
    expect(screen.getByRole("menuitem", { name: "Start sprint" })).toBeInTheDocument();
  });

  it("manager: Delete is hidden for a completed sprint", () => {
    setRole("manager");
    const done = makeSprint({ id: "s-done", seq: 6, status: "completed" });
    renderMenu(
      <SprintManageMenu
        sprints={[done]}
        selected="s-done"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    expect(screen.queryByTestId("sprint-action-delete")).toBeNull();
  });

  it("manager: Delete on a sprint WITH tasks toasts an error and sends no request", () => {
    setRole("manager");
    renderMenu(
      <SprintManageMenu
        sprints={[active]}
        selected="s-active"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    fireEvent.click(screen.getByTestId("sprint-action-delete"));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("5 tasks"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("manager: Delete on an empty sprint confirms then DELETEs and calls onDeleted", async () => {
    setRole("manager");
    apiFetchMock.mockResolvedValue({ data: { id: "s-plan" } } as never);
    const onDeleted = vi.fn();
    renderMenu(
      <SprintManageMenu
        sprints={[planned]}
        selected="s-plan"
        onNew={vi.fn()}
        onEdit={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));
    fireEvent.click(screen.getByTestId("sprint-action-delete"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete sprint" }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/sprints/s-plan",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });
});
