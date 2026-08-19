// portal-owner-ledger.ts — React-Query hook tests for usePortalStatementSections
// (task 2c-1). Mirrors the renderHook + fetch-mock precedent in meter.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Auth mock (required by the portal-api import chain) ──────────────────────
vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { usePortalStatementSections } from "../portal-owner-ledger";
import type { YannieSections } from "../owner-ledger";

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

// ── Fixture ───────────────────────────────────────────────────────────────────

const yannieSectionsFixture: YannieSections = {
  header: {
    reportMonth: "June 2026",
    propertyName: "Areca Residences",
    ownerName: "Ahmad",
    bankName: null,
    accountHolder: null,
    accountNumberMasked: null,
  },
  apartmentId: null,
  occupancy: {
    rows: [],
    occupiedCount: 0,
    vacantCount: 1,
    totalMonthlyRental: "0.00",
  },
  payoutSummary: {
    lines: [{ label: "Total Payout to Owner", amount: "0.00", isTotal: true }],
    netPayoutToOwner: "0.00",
    depositCollected: "0.00",
  },
  incomeBreakdown: {
    rows: [],
    totalIncome: "0.00",
    totalMgmtFee: "0.00",
  },
  expenseBreakdown: {
    rows: [],
    totalExpenses: "0.00",
  },
};

// ── usePortalStatementSections ────────────────────────────────────────────────

describe("usePortalStatementSections", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is disabled (does not fetch) when statementId is undefined", () => {
    const qc = makeQueryClient();
    renderHook(() => usePortalStatementSections(undefined), {
      wrapper: makeWrapper(qc),
    });

    expect(fetchMock().mock.calls).toHaveLength(0);
  });

  it("fetches /portal-api/owner/statements/:id/sections and returns YannieSections on success", async () => {
    fetchMock().mockResolvedValueOnce(
      makeResponse({ data: yannieSectionsFixture }),
    );

    const qc = makeQueryClient();
    const { result } = renderHook(
      () => usePortalStatementSections("stmt-portal-1"),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify the URL hits the portal-api path
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/portal-api/owner/statements/stmt-portal-1/sections");

    // Verify the YannieSections data shape is returned correctly
    const sections = result.current.data?.data;
    expect(sections?.header.reportMonth).toBe("June 2026");
    expect(sections?.occupancy.vacantCount).toBe(1);
    expect(sections?.payoutSummary.netPayoutToOwner).toBe("0.00");
  });

  it("uses queryKey [portal-statement-sections, statementId]", async () => {
    fetchMock().mockResolvedValue(
      makeResponse({ data: yannieSectionsFixture }),
    );

    const qc = makeQueryClient();
    renderHook(() => usePortalStatementSections("stmt-portal-2"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() =>
      expect(qc.getQueryState(["portal-statement-sections", "stmt-portal-2"])).toBeDefined(),
    );
  });
});
