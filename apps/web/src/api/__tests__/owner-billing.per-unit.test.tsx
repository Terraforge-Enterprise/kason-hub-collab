// owner-billing.per-unit.test.tsx — Tests for Task 8: apartmentId threading.
//
// NOTE (Task 3): useGenerateAllStatements and apartmentId threading in
// useGenerateStatement were REMOVED — the API now rejects apartmentId on
// POST /owner-billing/statements (.strict() Zod schema) and
// /statements/generate-all was deleted. Tests (a) and (d) are removed.
// Tests (b) + (c) for useOwnerMonthlySummaries apartmentId query param are
// retained as they test a still-valid read path (receipts scope).
//
// Mirrors the renderHook + vi.mock("@/lib/api-client") pattern from
// tasks-sprints.test.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { useOwnerMonthlySummaries } from "@/api/owner-ledger";

const apiFetchMock = vi.mocked(apiFetch);

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => vi.clearAllMocks());

// ── (b) + (c) useOwnerMonthlySummaries — apartmentId query param ──────────────

describe("useOwnerMonthlySummaries — apartmentId filter", () => {
  it("(b) appends ?apartmentId= to the URL when apartmentId is provided", async () => {
    apiFetchMock.mockResolvedValue({ data: { items: [] } } as never);
    const { result } = renderHook(
      () => useOwnerMonthlySummaries("owner-1", "apt-1"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/owner-ledger/owners/owner-1/months?apartmentId=apt-1",
    );
  });

  it("(c) uses bare URL with no querystring when apartmentId is absent (backward compat)", async () => {
    apiFetchMock.mockResolvedValue({ data: { items: [] } } as never);
    const { result } = renderHook(
      () => useOwnerMonthlySummaries("owner-1"),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith("/owner-ledger/owners/owner-1/months");
  });
});
