import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Sonner mock ──────────────────────────────────────────────────────────────
// vi.mock is hoisted, so we cannot reference outer variables in the factory.
// Instead we attach sub-functions inside the factory and retrieve them via import.
vi.mock("sonner", () => {
  const success = vi.fn();
  const error = vi.fn();
  const toastBase = vi.fn();
  (toastBase as any).success = success;
  (toastBase as any).error = error;
  return { toast: toastBase };
});

// ── Auth mock (required by api-client import chain) ──────────────────────────
vi.mock("../auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { toast } from "sonner";
import { createResourceMutations } from "../resource-mutations";

// Typed handles for assertions — resolved after mocks are installed
const toastFn = toast as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = (toast as any).success as ReturnType<typeof vi.fn>;
const toastError = (toast as any).error as ReturnType<typeof vi.fn>;

// ── Helpers ──────────────────────────────────────────────────────────────────
type SimpleDto = { id: string; displayName: string };

const TEST_CONFIG = {
  resource: "parties/agents",
  queryKey: ["parties", "agents"] as const,
  toasts: {
    create: "Agent created",
    update: "Saved",
    remove: "Removed",
    conflict: "Record changed — reloaded",
  },
};

const useAgentMutations = createResourceMutations<SimpleDto>(TEST_CONFIG);

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("createResourceMutations", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    toastFn.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── 1. Create success ───────────────────────────────────────────────────
  it("create success: resolves, fires success toast, invalidates queries", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const created: SimpleDto = { id: "new-1", displayName: "New Agent" };

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(created, 201),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.create.mutate({ displayName: "New Agent" });
    });

    await waitFor(() =>
      expect(result.current.create.isSuccess).toBe(true),
    );

    expect(result.current.create.data).toEqual(created);
    expect(toastSuccess).toHaveBeenCalledWith("Agent created");
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["parties", "agents"] }),
    );
  });

  // ── 2. Update optimistic patch ──────────────────────────────────────────
  it("update optimistic patch: mid-flight cache shows patched value, success toast fires", async () => {
    const queryClient = makeQueryClient();
    const original: SimpleDto = { id: "id1", displayName: "Old" };
    const updated: SimpleDto = { id: "id1", displayName: "New" };

    // Preload the cache with the original value
    queryClient.setQueryData(["parties", "agents", "id1"], original);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse(updated, 200),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    // Start the mutation and let onMutate complete (it's async due to cancelQueries)
    await act(async () => {
      result.current.update.mutate({ id: "id1", patch: { displayName: "New" } });
    });

    // onMutate has run — optimistic patch should be in the cache
    expect(
      queryClient.getQueryData(["parties", "agents", "id1"]),
    ).toEqual({ id: "id1", displayName: "New" });

    await waitFor(() =>
      expect(result.current.update.isSuccess).toBe(true),
    );

    expect(toastSuccess).toHaveBeenCalledWith("Saved");
  });

  // ── 3. Update optimistic rollback on error ──────────────────────────────
  it("update rollback on error: cache reverts to original, error toast fires", async () => {
    const queryClient = makeQueryClient();
    const original: SimpleDto = { id: "id1", displayName: "Old" };

    queryClient.setQueryData(["parties", "agents", "id1"], original);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "Internal error" }, 500),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.update.mutate({ id: "id1", patch: { displayName: "New" } });
    });

    await waitFor(() =>
      expect(result.current.update.isError).toBe(true),
    );

    // Cache should have been rolled back to the original
    expect(
      queryClient.getQueryData(["parties", "agents", "id1"]),
    ).toEqual(original);

    expect(toastError).toHaveBeenCalledWith("Internal error");
    expect(toastFn).not.toHaveBeenCalled(); // no conflict toast
  });

  // ── 4. 409 conflict ────────────────────────────────────────────────────
  it("409 conflict: fires conflict toast (not generic error toast)", async () => {
    const queryClient = makeQueryClient();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "Record changed — reloaded" }, 409),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.update.mutate({ id: "id1", patch: { displayName: "New" } });
    });

    await waitFor(() =>
      expect(result.current.update.isError).toBe(true),
    );

    expect(toastFn).toHaveBeenCalledWith("Record changed — reloaded");
    expect(toastError).not.toHaveBeenCalled();
  });

  // ── 5. Non-409 error with server message ───────────────────────────────
  it("non-409 error: toast.error fires with server message", async () => {
    const queryClient = makeQueryClient();

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "DB down" }, 500),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.create.mutate({ displayName: "Agent X" });
    });

    await waitFor(() =>
      expect(result.current.create.isError).toBe(true),
    );

    expect(toastError).toHaveBeenCalledWith("DB down");
    expect(toastFn).not.toHaveBeenCalled(); // no conflict toast
  });

  // ── 6. Remove success ──────────────────────────────────────────────────
  it("remove success: fires success toast and invalidates", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({}, 200),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.remove.mutate({ id: "id1" });
    });

    await waitFor(() =>
      expect(result.current.remove.isSuccess).toBe(true),
    );

    expect(toastSuccess).toHaveBeenCalledWith("Removed");
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["parties", "agents"] }),
    );
  });

  // ── 7. List optimistic patch (bare array) ───────────────────────────────
  it("update optimistic patch: mid-flight list cache shows patched value", async () => {
    const queryClient = makeQueryClient();
    const queryKey = ["parties", "agents"] as const;
    const listData: SimpleDto[] = [
      { id: "x", displayName: "Old" },
      { id: "other", displayName: "Other" },
    ];

    queryClient.setQueryData(queryKey, listData);

    // Delay server response so we can inspect mid-flight cache state
    let resolveRequest!: (r: Response) => void;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<Response>((res) => { resolveRequest = res; }),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    // Fire mutation — onMutate completes synchronously after cancelQueries
    await act(async () => {
      result.current.update.mutate({ id: "x", patch: { displayName: "New" } });
    });

    // Mid-flight: list cache should show the patched item
    const midFlight = queryClient.getQueryData<SimpleDto[]>(queryKey);
    expect(midFlight?.find((i) => i.id === "x")?.displayName).toBe("New");
    expect(midFlight?.find((i) => i.id === "other")?.displayName).toBe("Other");

    // Resolve server
    resolveRequest(makeResponse({ id: "x", displayName: "New" }, 200));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  // ── 8. List optimistic patch (wrapped { data: [...] } shape) ───────────
  it("update optimistic patch: mid-flight {data:[...]} list cache shows patched value", async () => {
    const queryClient = makeQueryClient();
    const queryKey = ["parties", "agents"] as const;
    const wrappedData = { data: [{ id: "x", displayName: "Old" }], total: 1 };

    queryClient.setQueryData(queryKey, wrappedData);

    let resolveRequest!: (r: Response) => void;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<Response>((res) => { resolveRequest = res; }),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.update.mutate({ id: "x", patch: { displayName: "New" } });
    });

    const midFlight = queryClient.getQueryData<{ data: SimpleDto[]; total: number }>(queryKey);
    expect(midFlight?.data.find((i) => i.id === "x")?.displayName).toBe("New");
    expect(midFlight?.total).toBe(1); // wrapper fields preserved

    resolveRequest(makeResponse({ id: "x", displayName: "New" }, 200));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  // ── 9. Rollback also reverts list cache ─────────────────────────────────
  it("update rollback: list cache reverts to original on error", async () => {
    const queryClient = makeQueryClient();
    const queryKey = ["parties", "agents"] as const;
    const original: SimpleDto[] = [{ id: "x", displayName: "Old" }];

    queryClient.setQueryData(queryKey, original);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "Internal error" }, 500),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.update.mutate({ id: "x", patch: { displayName: "New" } });
    });

    await waitFor(() => expect(result.current.update.isError).toBe(true));

    // List cache must revert
    const afterError = queryClient.getQueryData<SimpleDto[]>(queryKey);
    expect(afterError?.find((i) => i.id === "x")?.displayName).toBe("Old");
    expect(toastError).toHaveBeenCalledWith("Internal error");
  });

  // ── 10. Create error path ───────────────────────────────────────────────
  it("create error: toast.error fires on 500, invalidate called", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "DB error" }, 500),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.create.mutate({ displayName: "New Agent" });
    });

    await waitFor(() => expect(result.current.create.isError).toBe(true));

    expect(toastError).toHaveBeenCalledWith("DB error");
    expect(toastFn).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalled();
  });

  // ── 11b. Optimistic patch strips undefined ─────────────────────────────
  it("update optimistic patch: undefined keys do NOT clobber prevDetail", async () => {
    const queryClient = makeQueryClient();
    type ExtendedDto = SimpleDto & { email?: string | null; legalName?: string | null };
    const original: ExtendedDto = {
      id: "id1",
      displayName: "Old",
      email: "old@example.com",
      legalName: "Old Co.",
    };
    queryClient.setQueryData(["parties", "agents", "id1"], original);

    let resolveRequest!: (r: Response) => void;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<Response>((res) => { resolveRequest = res; }),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      // Patch declares email=undefined explicitly — the bug pattern from
      // form drawers using `field.trim() || undefined`. The optimistic
      // cache must NOT lose `email`.
      result.current.update.mutate({
        id: "id1",
        // Cast through unknown so TS lets us pass undefined explicitly here.
        patch: ({ displayName: "New", email: undefined } as unknown) as Partial<SimpleDto>,
      });
    });

    const midFlight = queryClient.getQueryData<ExtendedDto>([
      "parties",
      "agents",
      "id1",
    ]);
    expect(midFlight?.displayName).toBe("New");
    // The bug would have wiped these to undefined. With stripUndefined they
    // must be preserved exactly as in prevDetail.
    expect(midFlight?.email).toBe("old@example.com");
    expect(midFlight?.legalName).toBe("Old Co.");

    resolveRequest(makeResponse({ id: "id1", displayName: "New" }, 200));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  // ── 12. Empty string in patch IS preserved ─────────────────────────────
  it("update optimistic patch: empty string IS forwarded (user cleared the field)", async () => {
    const queryClient = makeQueryClient();
    type ExtendedDto = SimpleDto & { email?: string | null };
    const original: ExtendedDto = { id: "id1", displayName: "Old", email: "old@example.com" };
    queryClient.setQueryData(["parties", "agents", "id1"], original);

    let resolveRequest!: (r: Response) => void;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<Response>((res) => { resolveRequest = res; }),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.update.mutate({
        id: "id1",
        patch: ({ email: "" } as unknown) as Partial<SimpleDto>,
      });
    });

    const midFlight = queryClient.getQueryData<ExtendedDto>([
      "parties",
      "agents",
      "id1",
    ]);
    // Empty string MUST reach the cache unchanged — distinct from undefined.
    expect(midFlight?.email).toBe("");
    expect(midFlight?.displayName).toBe("Old");

    resolveRequest(makeResponse({ id: "id1", displayName: "Old" }, 200));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
  });

  // ── 11. Remove error path ───────────────────────────────────────────────
  it("remove error: toast.error fires on 500, invalidate called", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeResponse({ error: "Not found" }, 500),
    );

    const { result } = renderHook(() => useAgentMutations(), {
      wrapper: makeWrapper(queryClient),
    });

    act(() => {
      result.current.remove.mutate({ id: "id1" });
    });

    await waitFor(() => expect(result.current.remove.isError).toBe(true));

    expect(toastError).toHaveBeenCalledWith("Not found");
    expect(toastFn).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
