// owner-ledger.ts — React-Query hook tests for useOwnerMonthlySummaries
// and useStatementSections (task 2c-1).
// Follows the renderHook + fetch-mock precedent in
// src/api/__tests__/meter.test.ts and tenant-tracker.test.ts.
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
  useOwnerMonthlySummaries,
  useStatementSections,
  type MonthlyStatementSummary,
  type YannieSections,
} from "../owner-ledger";

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const monthlySummaryFixture: MonthlyStatementSummary = {
  month: "2026-06",
  grossRental: "3000.00",
  totalExpenses: "300.00",
  netPayoutToOwner: "2700.00",
  depositCollected: "0.00",
  statementId: "stmt-abc",
  statementStatus: "approved",
  hasData: true,
};

const yannieSectionsFixture: YannieSections = {
  header: {
    reportMonth: "June 2026",
    propertyName: "Areca Residences",
    ownerName: "Tan Sri Lim",
    bankName: "Maybank",
    accountHolder: "Lim Ah Kow",
    accountNumberMasked: "••••1234",
  },
  apartmentId: null,
  occupancy: {
    rows: [
      {
        unitCode: "A-01-01",
        tenantName: "Budi",
        tenancyStart: "2026-01-01",
        tenancyEnd: null,
        monthlyRental: "1500.00",
        depositMonths: 2,
        depositAmount: "0.00",
        isVacant: false,
      },
    ],
    occupiedCount: 1,
    vacantCount: 0,
    totalMonthlyRental: "1500.00",
  },
  payoutSummary: {
    lines: [
      { label: "Total Income Collected", amount: "3000.00" },
      { label: "Total Payout to Owner", amount: "2700.00", isTotal: true },
    ],
    netPayoutToOwner: "2700.00",
    depositCollected: "0.00",
  },
  incomeBreakdown: {
    rows: [
      {
        unitCode: "A-01-01",
        tenantName: "Budi",
        incomeType: "Monthly",
        billingPeriod: "June 2026",
        amount: "3000.00",
        mgmtFee: "300.00",
        mgmtFeeSst: "24.00",
        paymentStatus: "paid",
      },
    ],
    totalIncome: "3000.00",
    totalMgmtFee: "300.00",
  },
  expenseBreakdown: {
    rows: [
      {
        category: "Management Fee",
        categoryKey: "management_fee",
        description: null,
        amount: "300.00",
        sstAmount: "24.00",
        paymentStatus: "paid",
      },
    ],
    totalExpenses: "300.00",
  },
};

// ── useOwnerMonthlySummaries ──────────────────────────────────────────────────

describe("useOwnerMonthlySummaries", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is disabled (does not fetch) when ownerPartyId is undefined", () => {
    const qc = makeQueryClient();
    renderHook(() => useOwnerMonthlySummaries(undefined), {
      wrapper: makeWrapper(qc),
    });

    expect(fetchMock().mock.calls).toHaveLength(0);
  });

  it("fetches /owner-ledger/owners/:id/months and returns items on success", async () => {
    fetchMock().mockResolvedValueOnce(
      makeResponse({ data: { items: [monthlySummaryFixture] } }),
    );

    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useOwnerMonthlySummaries("owner-party-1"),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify the URL
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/owner-ledger/owners/owner-party-1/months");

    // Verify the returned data shape
    const items = result.current.data?.data.items;
    expect(items).toHaveLength(1);
    expect(items![0].month).toBe("2026-06");
    expect(items![0].grossRental).toBe("3000.00");
    expect(items![0].totalExpenses).toBe("300.00");
    expect(items![0].netPayoutToOwner).toBe("2700.00");
    expect(items![0].depositCollected).toBe("0.00");
    expect(items![0].statementId).toBe("stmt-abc");
    expect(items![0].statementStatus).toBe("approved");
    expect(items![0].hasData).toBe(true);
  });

  it("uses queryKey [owner-monthly-summaries, ownerPartyId]", async () => {
    fetchMock().mockResolvedValue(
      makeResponse({ data: { items: [monthlySummaryFixture] } }),
    );

    const qc = makeQueryClient();
    renderHook(() => useOwnerMonthlySummaries("owner-party-2"), {
      wrapper: makeWrapper(qc),
    });

    // Key is now 3-element: ["owner-monthly-summaries", ownerPartyId, apartmentId|null]
    // (null when no apartmentId provided). Updated after Task 8 added apartmentId support.
    await waitFor(() =>
      expect(qc.getQueryState(["owner-monthly-summaries", "owner-party-2", null])).toBeDefined(),
    );
  });
});

// ── useStatementSections ──────────────────────────────────────────────────────

describe("useStatementSections", () => {
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
    renderHook(() => useStatementSections(undefined), {
      wrapper: makeWrapper(qc),
    });

    expect(fetchMock().mock.calls).toHaveLength(0);
  });

  it("fetches /owner-billing/statements/:id/sections and returns YannieSections on success", async () => {
    fetchMock().mockResolvedValueOnce(
      makeResponse({ data: yannieSectionsFixture }),
    );

    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useStatementSections("stmt-abc"),
      { wrapper: makeWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify the URL
    const [url] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/owner-billing/statements/stmt-abc/sections");

    // Verify the 5-section structure
    const sections = result.current.data?.data;
    expect(sections?.header.reportMonth).toBe("June 2026");
    expect(sections?.header.ownerName).toBe("Tan Sri Lim");
    expect(sections?.occupancy.occupiedCount).toBe(1);
    expect(sections?.payoutSummary.netPayoutToOwner).toBe("2700.00");
    expect(sections?.incomeBreakdown.rows[0].incomeType).toBe("Monthly");
    expect(sections?.expenseBreakdown.rows[0].category).toBe("Management Fee");
  });

  it("uses queryKey [statement-sections, statementId]", async () => {
    fetchMock().mockResolvedValue(
      makeResponse({ data: yannieSectionsFixture }),
    );

    const qc = makeQueryClient();
    renderHook(() => useStatementSections("stmt-xyz"), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() =>
      expect(qc.getQueryState(["statement-sections", "stmt-xyz"])).toBeDefined(),
    );
  });
});
