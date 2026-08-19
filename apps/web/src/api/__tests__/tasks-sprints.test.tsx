import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import {
  SPRINTS_KEY,
  useSprints,
  useSprint,
  useSprintTrends,
  useCreateSprint,
  useUpdateSprint,
  useStartSprint,
  useCloseSprint,
  useSetTaskSprint,
  type SprintRow,
} from "@/api/tasks";

const apiFetchMock = vi.mocked(apiFetch);

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const sprintRow: SprintRow = {
  id: "11111111-1111-4111-8111-111111111111",
  seq: 3,
  name: null,
  goal: null,
  status: "active",
  startsOn: "2026-06-01T00:00:00.000Z",
  endsOn: "2026-06-15T00:00:00.000Z",
  startedAt: "2026-06-01T00:00:00.000Z",
  completedAt: null,
  summary: { committed: 4, completed: 3, carried: 1, completionPct: 75 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("sprint query hooks", () => {
  it("SPRINTS_KEY is the stable cache root", () => {
    expect(SPRINTS_KEY).toEqual(["sprints"]);
  });

  it("useSprints(status=active) GETs /sprints?status=active", async () => {
    apiFetchMock.mockResolvedValue({ data: [sprintRow] } as never);
    const { result } = renderHook(() => useSprints({ status: "active" }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/sprints?status=active");
    expect(result.current.data?.data[0].seq).toBe(3);
  });

  it("useSprints({}) GETs /sprints with no querystring", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    const { result } = renderHook(() => useSprints(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/sprints");
  });

  it("useSprints(undefined, { enabled:false }) does NOT fetch /sprints (board-dark guard, §1.12)", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    const { result } = renderHook(() => useSprints(undefined, { enabled: false }), {
      wrapper: wrapper(),
    });
    // Give react-query a tick — a disabled query must stay idle and never call apiFetch.
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    // pending + idle = "withheld", not resolved. (v5: isLoading is false for a
    // disabled query since isFetching is false — assert status/fetchStatus
    // directly, matching the project's tenant-tracker disabled-query convention.)
    expect(result.current.status).toBe("pending");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("useSprint(id) GETs /sprints/:id and is disabled when id is undefined", async () => {
    apiFetchMock.mockResolvedValue({ data: sprintRow } as never);
    const { result } = renderHook(() => useSprint(sprintRow.id), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith(`/sprints/${sprintRow.id}`);

    apiFetchMock.mockClear();
    renderHook(() => useSprint(undefined), { wrapper: wrapper() });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("useSprintTrends(window) GETs /sprints/trends?window=8 (replaces velocity)", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    const { result } = renderHook(() => useSprintTrends(8), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/sprints/trends?window=8");
  });

  it("useSprintTrends() GETs /sprints/trends with no querystring", async () => {
    apiFetchMock.mockResolvedValue({ data: [] } as never);
    const { result } = renderHook(() => useSprintTrends(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/sprints/trends");
  });

});

describe("sprint mutations", () => {
  it("useCreateSprint POSTs /sprints with the body", async () => {
    apiFetchMock.mockResolvedValue({ data: sprintRow } as never);
    const { result } = renderHook(() => useCreateSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({ name: "Sprint A", goal: "ship it" });
    expect(apiFetchMock).toHaveBeenCalledWith("/sprints", {
      method: "POST",
      body: JSON.stringify({ name: "Sprint A", goal: "ship it" }),
    });
  });

  it("useUpdateSprint PATCHes /sprints/:sprintId with the remaining body", async () => {
    apiFetchMock.mockResolvedValue({ data: sprintRow } as never);
    const { result } = renderHook(() => useUpdateSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      sprintId: sprintRow.id,
      updatedAt: sprintRow.updatedAt,
      name: "Renamed",
    });
    expect(apiFetchMock).toHaveBeenCalledWith(`/sprints/${sprintRow.id}`, {
      method: "PATCH",
      body: JSON.stringify({ updatedAt: sprintRow.updatedAt, name: "Renamed" }),
    });
  });

  it("useStartSprint POSTs /sprints/:sprintId/start with {updatedAt}", async () => {
    apiFetchMock.mockResolvedValue({ data: sprintRow } as never);
    const { result } = renderHook(() => useStartSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({ sprintId: sprintRow.id, updatedAt: sprintRow.updatedAt });
    expect(apiFetchMock).toHaveBeenCalledWith(`/sprints/${sprintRow.id}/start`, {
      method: "POST",
      body: JSON.stringify({ updatedAt: sprintRow.updatedAt }),
    });
  });

  it("useCloseSprint POSTs /sprints/:sprintId/close with {updatedAt}", async () => {
    apiFetchMock.mockResolvedValue({ data: sprintRow } as never);
    const { result } = renderHook(() => useCloseSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({ sprintId: sprintRow.id, updatedAt: sprintRow.updatedAt });
    expect(apiFetchMock).toHaveBeenCalledWith(`/sprints/${sprintRow.id}/close`, {
      method: "POST",
      body: JSON.stringify({ updatedAt: sprintRow.updatedAt }),
    });
  });

  it("useSetTaskSprint PATCHes /tasks/:taskId with {updatedAt, sprintId}", async () => {
    apiFetchMock.mockResolvedValue({ data: { id: "task-1" } } as never);
    const { result } = renderHook(() => useSetTaskSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      taskId: "task-1",
      updatedAt: "2026-06-10T00:00:00.000Z",
      sprintId: sprintRow.id,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/tasks/task-1", {
      method: "PATCH",
      body: JSON.stringify({ updatedAt: "2026-06-10T00:00:00.000Z", sprintId: sprintRow.id }),
    });
  });

  it("useSetTaskSprint with sprintId:null moves a task to the Backlog", async () => {
    apiFetchMock.mockResolvedValue({ data: { id: "task-1" } } as never);
    const { result } = renderHook(() => useSetTaskSprint(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      taskId: "task-1",
      updatedAt: "2026-06-10T00:00:00.000Z",
      sprintId: null,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/tasks/task-1", {
      method: "PATCH",
      body: JSON.stringify({ updatedAt: "2026-06-10T00:00:00.000Z", sprintId: null }),
    });
  });
});
