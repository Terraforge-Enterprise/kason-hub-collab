import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

import { apiFetch } from "@/lib/api-client";
import type { SprintRow } from "@/api/tasks";
import { SprintDrawer } from "../sprint-drawer";

const apiFetchMock = vi.mocked(apiFetch);

const existing: SprintRow = {
  id: "s-1",
  seq: 2,
  name: "Old name",
  goal: "Old goal",
  status: "planned",
  startsOn: "2026-06-01T00:00:00.000Z",
  endsOn: "2026-06-15T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  summary: { committed: 0, completed: 0, carried: 0, completionPct: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};

function renderDrawer(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ data: existing } as never);
});

describe("SprintDrawer", () => {
  it("create: root testid + §1.12 placeholders; POSTs /sprints then closes drawer with toast", async () => {
    const onClose = vi.fn();
    renderDrawer(<SprintDrawer open mode="create" onClose={onClose} />);

    // §1.12 root testid + placeholders.
    expect(screen.getByTestId("sprint-drawer")).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText("Sprint name");
    const goalInput = screen.getByPlaceholderText("Sprint goal (optional)");
    fireEvent.change(nameInput, { target: { value: "Sprint Alpha" } });
    fireEvent.change(goalInput, { target: { value: "Ship billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create sprint" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/sprints",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/sprints")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      name: "Sprint Alpha",
      goal: "Ship billing",
    });
    // Closes on success with a toast (no stay-open banner).
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Sprint created");
    expect(screen.queryByText("Sprint created")).toBeNull();
  });

  it("edit: PATCHes /sprints/:id with sprintId + updatedAt + changed name, then closes drawer with toast", async () => {
    const onClose = vi.fn();
    renderDrawer(<SprintDrawer open mode="edit" sprint={existing} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Sprint name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sprint" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/sprints/s-1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const call = apiFetchMock.mock.calls.find((c) => c[0] === "/sprints/s-1")!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.updatedAt).toBe("2026-06-10T00:00:00.000Z");
    expect(body.name).toBe("New name");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toastSuccess).toHaveBeenCalledWith("Sprint updated");
  });
});
