// Tenant Tracker (M1) — data-layer tests.
// Mirrors the renderHook + fetch-mock precedent in
// src/lib/__tests__/resource-mutations.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Auth mock (required by the api-client import chain) ──────────────────────
vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { ApiError } from "@/lib/api-client";
import {
  downloadTrackerExport,
  isLookupEnabled,
  isStaleAssignError,
  nextPageParam,
  normalizeTrackerKeyFilters,
  parseAttachmentFilename,
  useAssignInCharge,
  useRevealIc,
  useTenantTrackerInfinite,
  useTenantTrackerLookup,
  type TrackerPageFilters,
} from "../tenant-tracker";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      // staleTime Infinity so a second observer of the SAME key reads the
      // cache instead of background-refetching — lets the key-normalization
      // test prove cache sharing by counting fetch calls.
      queries: { retry: false, staleTime: Infinity },
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

const fetchMock = () => globalThis.fetch as ReturnType<typeof vi.fn>;
const fetchUrl = (callIndex: number) => String(fetchMock().mock.calls[callIndex][0]);

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("normalizeTrackerKeyFilters", () => {
  it("strips undefined and empty-string entries", () => {
    expect(
      normalizeTrackerKeyFilters({
        status: "active",
        q: undefined,
        agent: "",
        propertyId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      status: "active",
      propertyId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("two filter objects differing only by undefined/empty fields produce the same key", () => {
    const a: TrackerPageFilters = { status: "active" };
    const b: TrackerPageFilters = { status: "active", q: undefined, roomType: "" };
    expect(normalizeTrackerKeyFilters(a)).toEqual(normalizeTrackerKeyFilters(b));
    expect(["tenant-tracker", normalizeTrackerKeyFilters(a)]).toEqual([
      "tenant-tracker",
      normalizeTrackerKeyFilters(b),
    ]);
  });

  it("strips pagination params (cursor/limit) even when spread in at runtime", () => {
    expect(
      normalizeTrackerKeyFilters({
        status: "active",
        cursor: "abc",
        limit: 25,
      } as unknown as TrackerPageFilters),
    ).toEqual({ status: "active" });
  });

  it("sorts keys for deterministic structural equality", () => {
    expect(Object.keys(normalizeTrackerKeyFilters({ status: "all", q: "ali", agent: "KC" }))).toEqual([
      "agent",
      "q",
      "status",
    ]);
  });
});

describe("isLookupEnabled", () => {
  it("is disabled below 4 digits", () => {
    expect(isLookupEnabled("")).toBe(false);
    expect(isLookupEnabled("123")).toBe(false);
    expect(isLookupEnabled("+60 1")).toBe(false); // 3 digits among separators
  });

  it("is enabled at 4+ digits, counting digits only", () => {
    expect(isLookupEnabled("1234")).toBe(true);
    expect(isLookupEnabled("01-23")).toBe(true); // separators don't count
    expect(isLookupEnabled("+6012 345 6789")).toBe(true);
  });
});

describe("nextPageParam", () => {
  it("maps null nextCursor to undefined (v5 'no more pages')", () => {
    expect(nextPageParam({ groups: [], nextCursor: null })).toBeUndefined();
  });

  it("passes a real cursor through", () => {
    expect(nextPageParam({ groups: [], nextCursor: "abc" })).toBe("abc");
  });
});

describe("isStaleAssignError", () => {
  it("is true only for ApiError with status 409", () => {
    expect(isStaleAssignError(new ApiError("STALE", 409))).toBe(true);
    expect(isStaleAssignError(new ApiError("Not found", 404))).toBe(false);
    expect(isStaleAssignError(new Error("boom"))).toBe(false);
    expect(isStaleAssignError(undefined)).toBe(false);
  });
});

describe("parseAttachmentFilename", () => {
  it("parses the plain filename form", () => {
    expect(parseAttachmentFilename('attachment; filename="tenant-tracker.xlsx"')).toBe(
      "tenant-tracker.xlsx",
    );
  });

  it("prefers the RFC 6266 filename* form and decodes it", () => {
    expect(
      parseAttachmentFilename("attachment; filename*=UTF-8''tenant%20tracker.xlsx"),
    ).toBe("tenant tracker.xlsx");
  });

  it("returns null when the header is missing", () => {
    expect(parseAttachmentFilename(null)).toBeNull();
  });
});

// ── Hooks ────────────────────────────────────────────────────────────────────

describe("tenant-tracker hooks", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("useTenantTrackerInfinite: paginates via cursor and stops on null nextCursor", async () => {
    const queryClient = makeQueryClient();
    fetchMock()
      .mockResolvedValueOnce(makeResponse({ groups: [], nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(makeResponse({ groups: [], nextCursor: null }));

    const { result } = renderHook(
      () => useTenantTrackerInfinite({ status: "active", q: undefined }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl(0)).toContain("/tenant-tracker?");
    expect(fetchUrl(0)).toContain("status=active");
    expect(fetchUrl(0)).toContain("limit=25");
    expect(fetchUrl(0)).not.toContain("cursor=");
    expect(fetchUrl(0)).not.toContain("q="); // undefined filter stripped
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(fetchUrl(1)).toContain("cursor=cursor-1");
    expect(result.current.hasNextPage).toBe(false);
  });

  it("useTenantTrackerInfinite: normalized keys share one cache entry across undefined-field variants", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ groups: [], nextCursor: null }));

    const first = renderHook(() => useTenantTrackerInfinite({ status: "active" }), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    // Same logical filters, but with undefined/empty noise — must hit the
    // same cache entry (no second fetch).
    const second = renderHook(
      () => useTenantTrackerInfinite({ status: "active", q: undefined, agent: "" }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("useTenantTrackerLookup: disabled at 3 digits, fires at 4", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse([]));

    const disabled = renderHook(() => useTenantTrackerLookup("123"), {
      wrapper: makeWrapper(queryClient),
    });
    expect(disabled.result.current.fetchStatus).toBe("idle");
    expect(fetchMock()).not.toHaveBeenCalled();

    const enabled = renderHook(() => useTenantTrackerLookup("0123"), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true));
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(fetchUrl(0)).toContain("/tenant-tracker/lookup?phone=0123");
  });

  it("useAssignInCharge: PATCHes the unit and invalidates the tenant-tracker family", async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fetchMock().mockResolvedValueOnce(
      makeResponse({ inChargePartyId: "p-1", inChargeName: "Alice" }),
    );

    const { result } = renderHook(() => useAssignInCharge(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({
        unitId: "u-1",
        inChargePartyId: "p-1",
        expectedUpdatedAt: "2026-06-12T00:00:00.000Z",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl(0)).toContain("/tenant-tracker/u-1/in-charge");
    expect(fetchMock().mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["tenant-tracker"] }),
    );
  });

  it("useAssignInCharge: 409 surfaces as a stale error detectable via isStaleAssignError", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ error: "STALE" }, 409));

    const { result } = renderHook(() => useAssignInCharge(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ unitId: "u-1", inChargePartyId: null });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isStaleAssignError(result.current.error)).toBe(true);
  });

  it("useRevealIc: POSTs { partyId } to /ic-reveal", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(
      makeResponse({ partyId: "party-9", idNumber: "990101145566" }),
    );

    const { result } = renderHook(() => useRevealIc(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ partyId: "party-9" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl(0)).toContain("/tenant-tracker/ic-reveal");
    const init = fetchMock().mock.calls[0][1] as RequestInit;
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init.body))).toEqual({ partyId: "party-9" });
    // The hook surfaces the raw IC to the caller…
    expect(result.current.data?.idNumber).toBe("990101145566");
  });

  it("useRevealIc: performs NO cache writes — the raw IC enters no query entry", async () => {
    const queryClient = makeQueryClient();
    const RAW_IC = "990101145566";
    fetchMock().mockResolvedValueOnce(
      makeResponse({ partyId: "party-9", idNumber: RAW_IC }),
    );
    // A spy on the cache-write surface: a successful reveal must invalidate
    // nothing and write nothing (contrast useAssignInCharge, which invalidates).
    const setSpy = vi.spyOn(queryClient, "setQueryData");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRevealIc(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ partyId: "party-9" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Load-bearing assertion: the unmasked IC appears in NO cached query value.
    const leaked = queryClient
      .getQueryCache()
      .getAll()
      .some((entry) => JSON.stringify(entry.state.data ?? null).includes(RAW_IC));
    expect(leaked).toBe(false);
    // Belt-and-braces: the mutation never touched the cache at all.
    expect(setSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("normalizeTrackerKeyFilters — occupiedOnly", () => {
  it("sends true, omits false (belt-and-braces vs the stringbool footgun)", () => {
    expect(
      normalizeTrackerKeyFilters({ status: "active", occupiedOnly: true }),
    ).toEqual({ status: "active", occupiedOnly: "true" });
    expect(
      normalizeTrackerKeyFilters({ status: "active", occupiedOnly: false }),
    ).toEqual({ status: "active" });
  });
});

// ── downloadTrackerExport ────────────────────────────────────────────────────
// Request/error logic only — DOM glue (anchor attributes, body append/remove)
// is intentionally not asserted.

describe("downloadTrackerExport", () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fake timers so the deferred revokeObjectURL (setTimeout 1000) is flushed
    // in afterEach while the stub is still installed.
    vi.useFakeTimers();
    globalThis.fetch = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("builds the query from filters, stripping cursor/limit and empty entries", async () => {
    fetchMock().mockResolvedValueOnce(
      new Response("xlsx-bytes", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="custom.xlsx"' },
      }),
    );

    await downloadTrackerExport({
      status: "active",
      agent: "KC",
      q: "",
      cursor: "leak",
      limit: 99,
    } as unknown as TrackerPageFilters);

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    const url = fetchUrl(0);
    expect(url).toContain("/tenant-tracker/export.xlsx?");
    expect(url).toContain("status=active");
    expect(url).toContain("agent=KC");
    expect(url).not.toContain("cursor");
    expect(url).not.toContain("limit");
    expect(url).not.toContain("q=");
    // Same credential convention as apiFetch (cookie channel kept alongside
    // the bearer header — token is mocked to null in this suite).
    expect(fetchMock().mock.calls[0][1]).toMatchObject({ credentials: "include" });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("throws ApiError with the response status on non-2xx and triggers no download", async () => {
    fetchMock().mockResolvedValueOnce(
      makeResponse({ error: "You don't have permission to do that." }, 403),
    );

    const err: unknown = await downloadTrackerExport({ status: "all" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe("You don't have permission to do that.");
    expect(clickSpy).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
