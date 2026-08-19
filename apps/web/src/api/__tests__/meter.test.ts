// meter.ts — React-Query hook cache-invalidation tests.
// Mirrors the renderHook + fetch-mock precedent in
// src/api/__tests__/tenant-tracker.test.ts.
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

import { useSetTenancyPax } from "../meter";
import { TRACKER_KEY_BASE } from "../tenant-tracker";

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

// ── useSetTenancyPax ─────────────────────────────────────────────────────────

describe("useSetTenancyPax", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('invalidates ["meter"] AND ["tenant-tracker"] (TRACKER_KEY_BASE) on success', async () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fetchMock().mockResolvedValueOnce(makeResponse({ ok: true }));

    const { result } = renderHook(() => useSetTenancyPax(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ tenancyId: "t1", numberOfPax: 3 });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Must invalidate the billing-grid family so the bill workspace refetches.
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["meter"] }),
    );

    // Must ALSO invalidate the tenant-tracker family so the Tenant Tracker
    // page reflects the updated pax without a manual refresh.
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: TRACKER_KEY_BASE }),
    );
  });

  it("PATCHes the correct endpoint with numberOfPax in the body", async () => {
    const queryClient = makeQueryClient();
    fetchMock().mockResolvedValueOnce(makeResponse({ ok: true }));

    const { result } = renderHook(() => useSetTenancyPax(), {
      wrapper: makeWrapper(queryClient),
    });

    await act(async () => {
      result.current.mutate({ tenancyId: "tenancy-abc", numberOfPax: 5 });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const calls = fetchMock().mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain("/meter/tenancies/tenancy-abc/pax");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      numberOfPax: 5,
    });
  });
});
