// Analytics (Spec 2) — data-layer tests.
// Mirrors the renderHook + fetch-mock precedent in __tests__/tenant-tracker.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Auth mock (required by the api-client import chain) ──────────────────────
vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import {
  ANALYTICS_KEY,
  useAnalyticsTrend,
  useCategoryLens,
  useUnitAnalytics,
  useUnitMiniStat,
} from "../analytics";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
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
const fetchUrl = (callIndex = 0) => String(fetchMock().mock.calls[callIndex][0]);

// ── Query key constant ────────────────────────────────────────────────────────

describe("ANALYTICS_KEY", () => {
  it("is a tuple rooted at 'analytics'", () => {
    expect(ANALYTICS_KEY).toEqual(["analytics"]);
  });
});

// ── Hooks ─────────────────────────────────────────────────────────────────────

describe("analytics hooks", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("useUnitAnalytics: GETs /analytics/units with sanitized filters", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(
      makeResponse({
        data: {
          units: [],
          unmapped: { count: 0 },
          summary: { mttrDays: null, oldestOpenDays: null, openOver30: 0 },
        },
      }),
    );

    const { result } = renderHook(
      () => useUnitAnalytics({ window: "12mo", propertyId: "" }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl()).toContain("/analytics/units");
    expect(fetchUrl()).toContain("window=12mo");
    // empty propertyId must be stripped
    expect(fetchUrl()).not.toContain("propertyId");
  });

  it("useUnitAnalytics: empty filters → no querystring", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(
      makeResponse({
        data: {
          units: [],
          unmapped: { count: 0 },
          summary: { mttrDays: null, oldestOpenDays: null, openOver30: 0 },
        },
      }),
    );

    renderHook(() => useUnitAnalytics(), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => fetchMock().mock.calls.length > 0);
    expect(fetchUrl()).toMatch(/\/analytics\/units$/);
  });

  it("useCategoryLens: GETs /analytics/categories", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ data: [] }));

    const { result } = renderHook(
      () => useCategoryLens({ window: "30d" }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl()).toContain("/analytics/categories");
    expect(fetchUrl()).toContain("window=30d");
  });

  it("useAnalyticsTrend: GETs /analytics/trend with propertyId", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ data: [] }));

    const { result } = renderHook(
      () => useAnalyticsTrend({ window: "90d", propertyId: "prop-1" }),
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl()).toContain("/analytics/trend");
    expect(fetchUrl()).toContain("window=90d");
    expect(fetchUrl()).toContain("propertyId=prop-1");
  });

  it("useUnitMiniStat: GETs /analytics/units/:unitId?window= with default window", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(
      makeResponse({ data: { total: 5, open: 1, recurringCategories: [], byCategory: [] } }),
    );

    const { result } = renderHook(() => useUnitMiniStat("unit-abc"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl()).toContain("/analytics/units/unit-abc");
    expect(fetchUrl()).toContain("window=12mo");
  });

  it("useUnitMiniStat: disabled when unitId is empty string", () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ data: {} }));

    const { result } = renderHook(() => useUnitMiniStat(""), {
      wrapper: makeWrapper(queryClient),
    });

    // enabled: Boolean("") === false — should remain idle
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("useUnitMiniStat: accepts explicit window override", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(
      makeResponse({ data: { total: 3, open: 0, recurringCategories: [], byCategory: [] } }),
    );

    const { result } = renderHook(() => useUnitMiniStat("unit-xyz", "all"), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchUrl()).toContain("window=all");
  });
});
