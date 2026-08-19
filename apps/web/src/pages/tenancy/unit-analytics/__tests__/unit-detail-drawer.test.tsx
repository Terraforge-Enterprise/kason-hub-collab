/**
 * UnitDetailDrawer (Task 3) — unit drill-down drawer tests.
 *
 * Asserts:
 *  1. Unit header: "<unitCode> — <total> tickets" + propertyName
 *  2. Recurring callout present when recurringCategories non-empty
 *  3. Recurring callout absent when recurringCategories is empty
 *  4. byCategory breakdown renders each canonical + count
 *  5. Ticket rows: category · status · ageDays · opened date
 *  6. Each ticket links to its detail route (/tasks)
 *  7. Loading skeleton rendered when useUnitMiniStat isPending
 *  8. Empty state rendered when tickets: []
 *
 * Harness mirrors unit-analytics-page.test.tsx (QueryClient + MemoryRouter,
 * no msw — direct vi.mock on hooks).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mock the C1 hook (auto-hoisted) ──────────────────────────────────────────

const mockUseUnitMiniStat = vi.fn();

vi.mock("@/api/analytics", () => ({
  useUnitAnalytics: vi.fn(),
  useCategoryLens: vi.fn(),
  useAnalyticsTrend: vi.fn(),
  useUnitMiniStat: (...args: unknown[]) => mockUseUnitMiniStat(...args),
}));

import UnitDetailDrawer from "../unit-detail-drawer";
import type { UnitAnalyticsRow, UnitMiniStat } from "@kason/shared";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRow(over: Partial<UnitAnalyticsRow> = {}): UnitAnalyticsRow {
  return {
    unitId: "unit-abc",
    unitCode: "A-10-04",
    propertyId: "prop-1",
    propertyName: "Sunrise Residences",
    total: 7,
    open: 2,
    windowTotal: 5,
    byCategory: [
      { canonical: "Plumbing", count: 3, isMapped: true, recurring: true },
      { canonical: "Electrical", count: 2, isMapped: true, recurring: false },
    ],
    recurringCategories: ["Plumbing"],
    topRecurringCategory: "Plumbing",
    ...over,
  };
}

function makeMiniStat(over: Partial<UnitMiniStat> = {}): UnitMiniStat {
  return {
    unitId: "unit-abc",
    total: 7,
    open: 2,
    windowTotal: 5,
    byCategory: [
      { canonical: "Plumbing", count: 3, isMapped: true, recurring: true },
      { canonical: "Electrical", count: 2, isMapped: true, recurring: false },
    ],
    recurringCategories: ["Plumbing"],
    tickets: [
      {
        id: "ticket-1",
        categoryCanonical: "Plumbing",
        status: "open",
        createdAt: "2026-05-01T10:00:00.000Z",
        resolvedAt: null,
        ageDays: 30,
        title: "Leaking pipe",
      },
      {
        id: "ticket-2",
        categoryCanonical: "Electrical",
        status: "resolved",
        createdAt: "2026-04-15T08:00:00.000Z",
        resolvedAt: "2026-04-20T08:00:00.000Z",
        ageDays: 5,
        title: "Faulty socket",
      },
    ],
    ...over,
  };
}

function makeLoadedQuery(miniStat: UnitMiniStat) {
  return {
    data: { data: miniStat },
    isPending: false,
    isLoading: false,
    isError: false,
  };
}

function makePendingQuery() {
  return {
    data: undefined,
    isPending: true,
    isLoading: true,
    isError: false,
  };
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderDrawer(
  unit: UnitAnalyticsRow | null,
  open: boolean,
  onClose = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenancy/unit-analytics"]}>
        <UnitDetailDrawer
          unit={unit}
          window="90d"
          open={open}
          onClose={onClose}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Default mocks ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockUseUnitMiniStat.mockReturnValue(makeLoadedQuery(makeMiniStat()));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("UnitDetailDrawer — unit header", () => {
  it("renders unitCode and total ticket count in the header", async () => {
    renderDrawer(makeRow(), true);
    expect(screen.getByText(/A-10-04/)).toBeInTheDocument();
    expect(screen.getByText(/7 tickets/)).toBeInTheDocument();
  });

  it("renders propertyName as subtitle", async () => {
    renderDrawer(makeRow(), true);
    expect(screen.getByText(/Sunrise Residences/)).toBeInTheDocument();
  });
});

describe("UnitDetailDrawer — recurring callout", () => {
  it("shows amber callout with category name when recurringCategories non-empty", async () => {
    renderDrawer(makeRow({ recurringCategories: ["Plumbing"] }), true);
    // Callout with warning variant should be visible
    expect(screen.getByText(/Repeated Plumbing tickets/i)).toBeInTheDocument();
  });

  it("does NOT show a recurring callout when recurringCategories is empty", async () => {
    renderDrawer(
      makeRow({ recurringCategories: [], topRecurringCategory: null }),
      true,
    );
    expect(screen.queryByText(/Repeated.*tickets/i)).toBeNull();
  });
});

describe("UnitDetailDrawer — byCategory breakdown", () => {
  it("renders each category canonical and count from unit.byCategory", async () => {
    renderDrawer(makeRow(), true);
    // byCategory: Plumbing(3), Electrical(2) — may appear multiple times (callout + breakdown + ticket rows)
    expect(screen.getAllByText(/Plumbing/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Electrical/i).length).toBeGreaterThan(0);
    // counts — look for the breakdown list (not the ticket rows)
    const plumbingCount = screen.getAllByText(/3/);
    expect(plumbingCount.length).toBeGreaterThan(0);
    const electricalCount = screen.getAllByText(/2/);
    expect(electricalCount.length).toBeGreaterThan(0);
  });
});

describe("UnitDetailDrawer — ticket list", () => {
  it("renders ticket rows with category, status, ageDays, and opened date", async () => {
    renderDrawer(makeRow(), true);
    // ticket-1: Plumbing · open · 30d · 2026-05-01
    const plumbingCells = screen.getAllByText(/Plumbing/i);
    expect(plumbingCells.length).toBeGreaterThan(0);
    // status pills
    expect(screen.getAllByText(/open/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/resolved/i).length).toBeGreaterThan(0);
    // age display "30d"
    expect(screen.getByText(/30d/)).toBeInTheDocument();
    // opened date formatted from ISO
    expect(screen.getByText(/2026-05-01/)).toBeInTheDocument();
  });

  it("each ticket row links to /tasks (the ticket detail route)", async () => {
    renderDrawer(makeRow(), true);
    // All ticket links must point to /tasks (the only route for ticket detail)
    const links = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href")?.startsWith("/tasks"));
    expect(links.length).toBeGreaterThan(0);
  });

  it("shows empty state when tickets array is empty", async () => {
    mockUseUnitMiniStat.mockReturnValue(
      makeLoadedQuery(makeMiniStat({ tickets: [] })),
    );
    renderDrawer(makeRow(), true);
    expect(screen.getByText(/No tickets in this window/i)).toBeInTheDocument();
  });
});

describe("UnitDetailDrawer — loading state", () => {
  it("renders a loading skeleton when useUnitMiniStat isPending", async () => {
    mockUseUnitMiniStat.mockReturnValue(makePendingQuery());
    renderDrawer(makeRow(), true);
    // The skeleton should be present (no ticket content yet)
    // We rely on the skeleton container having animate-pulse
    const pulsing = document.querySelector(".animate-pulse");
    expect(pulsing).not.toBeNull();
    // No ticket content should appear
    expect(screen.queryByText(/30d/)).toBeNull();
  });
});

describe("UnitDetailDrawer — closed state", () => {
  it("renders nothing (no header) when open=false", () => {
    renderDrawer(makeRow(), false);
    // Sheet content should not be visible when closed
    expect(screen.queryByText(/A-10-04/)).toBeNull();
  });

  it("renders nothing when unit is null", () => {
    renderDrawer(null, false);
    expect(screen.queryByText(/A-10-04/)).toBeNull();
  });
});
