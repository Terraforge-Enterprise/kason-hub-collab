/**
 * Unit Analytics page (C2) — page tests.
 *
 * Asserts:
 *  1. Ranked table renders rows in API-returned order (worst-first, not re-sorted)
 *  2. A unit with recurringCategories shows inline amber StatusPill chips
 *  3. Unmapped nudge appears when unmapped.count > 0 (with correct "grouped under 'Other'" copy)
 *     and is absent when 0
 *  4. Changing the window via Segmented triggers refetch (hook called with new window)
 *  5. RecurringProblemsPanel is NOT rendered (collapsed into inline chips)
 *
 * Harness pattern: QueryClient + MemoryRouter, no msw — direct vi.mock on hooks.
 * (Copied from owner-statements-page.test.tsx, which was deleted with its page.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mock the C1 hooks (vi.mock auto-hoisted above imports) ────────────────────

const mockUseUnitAnalytics = vi.fn();
const mockUseCategoryLens = vi.fn();
const mockUseAnalyticsTrend = vi.fn();
const mockUseTrackerSummary = vi.fn();

vi.mock("@/api/analytics", () => ({
  useUnitAnalytics: (...args: unknown[]) => mockUseUnitAnalytics(...args),
  useCategoryLens: (...args: unknown[]) => mockUseCategoryLens(...args),
  useAnalyticsTrend: (...args: unknown[]) => mockUseAnalyticsTrend(...args),
}));

vi.mock("@/api/tenant-tracker", () => ({
  useTrackerSummary: () => mockUseTrackerSummary(),
}));

// Recharts needs ResizeObserver in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import UnitAnalyticsPage from "../unit-analytics-page";
import type { UnitAnalyticsRow } from "@kason/shared";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRow(over: Partial<UnitAnalyticsRow>): UnitAnalyticsRow {
  return {
    unitId: "unit-a",
    unitCode: "A-01-01",
    propertyId: "prop-1",
    propertyName: "Sunrise Residences",
    total: 5,
    open: 1,
    windowTotal: 5,
    byCategory: [],
    recurringCategories: [],
    topRecurringCategory: null,
    ...over,
  };
}

// Fixture: open is strictly descending (3 > 2 > 0) so API order == open-desc sort order.
// This lets us assert both "row order" and "default sort" without conflict.
const worstFirst: UnitAnalyticsRow[] = [
  makeRow({ unitId: "unit-1", unitCode: "B-10-3A", windowTotal: 12, open: 3 }),
  makeRow({
    unitId: "unit-3",
    unitCode: "C-02-1C",
    windowTotal: 4,
    open: 2,
    byCategory: [
      { canonical: "Plumbing", count: 3, isMapped: true, recurring: true },
      { canonical: "Electrical", count: 2, isMapped: true, recurring: false },
    ],
    recurringCategories: ["Plumbing", "Electrical"],
    topRecurringCategory: "Plumbing",
  }),
  makeRow({ unitId: "unit-2", unitCode: "A-05-2B", windowTotal: 7, open: 0 }),
];

function makeAnalyticsData(rows: UnitAnalyticsRow[], unmappedCount = 0) {
  return {
    // Hook returns the API envelope shape: { data: { data: UnitsAnalyticsResponse } }
    data: {
      data: {
        rows,
        unmapped: { count: unmappedCount },
        summary: {
          mttrDays: 4.2,
          oldestOpenDays: 18.0,
          openOver30: 2,
        },
      },
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

function makeCategoryData() {
  return {
    data: { data: [{ canonical: "Plumbing", total: 8, units: [] }] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

function makeTrendData() {
  return {
    data: { data: [{ month: "2026-01", created: 4, resolved: 3 }, { month: "2026-02", created: 8, resolved: 6 }] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

function makeSummary() {
  return {
    data: {
      properties: [
        { propertyId: "prop-1", name: "Sunrise Residences", propertyCode: "SUN", apartments: 30, rooms: 60, activeTenancies: 45, vacantRooms: 15 },
      ],
      totals: { apartments: 30, rooms: 60, activeTenancies: 45, vacantRooms: 15 },
    },
    isLoading: false,
    isPending: false,
    isError: false,
  };
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenancy/unit-analytics"]}>
        <UnitAnalyticsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Default stub (all mocks) ──────────────────────────────────────────────────

function setupMocks(unmappedCount = 0, rows = worstFirst) {
  mockUseUnitAnalytics.mockReturnValue(makeAnalyticsData(rows, unmappedCount));
  mockUseCategoryLens.mockReturnValue(makeCategoryData());
  mockUseAnalyticsTrend.mockReturnValue(makeTrendData());
  mockUseTrackerSummary.mockReturnValue(makeSummary());
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("UnitAnalyticsPage — ranked unit table", () => {
  it("renders rows worst-first by open (default sort: open desc)", async () => {
    renderPage();

    // Wait for the unit codes to appear (both lg-table and mobile cards render in jsdom)
    await screen.findAllByText("B-10-3A");

    // Fixture: B-10-3A (open=3) > C-02-1C (open=2) > A-05-2B (open=0)
    // Default sort is open desc, so fixture order == rendered order.
    const body = document.body.textContent ?? "";
    const firstPos = body.indexOf("B-10-3A");
    const secondPos = body.indexOf("C-02-1C");
    const thirdPos = body.indexOf("A-05-2B");
    expect(firstPos).toBeGreaterThanOrEqual(0);
    expect(secondPos).toBeGreaterThan(firstPos);
    expect(thirdPos).toBeGreaterThan(secondPos);
  });

  it("shows windowTotal values as returned by the API", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    // windowTotal=12 for worst unit (appears in table cell or card)
    expect(screen.getAllByText("12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
  });

  it("renders Open column before In-window and All-time columns", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");

    const body = document.body.textContent ?? "";
    const openPos = body.indexOf("Open");
    const inWindowPos = body.indexOf("In window");
    const allTimePos = body.indexOf("All-time");

    expect(openPos).toBeGreaterThanOrEqual(0);
    expect(inWindowPos).toBeGreaterThan(openPos);
    expect(allTimePos).toBeGreaterThan(inWindowPos);
  });
});

describe("UnitAnalyticsPage — recurring chips (inline, not badge)", () => {
  it("shows byCategory pills inline for a unit — format '<canonical> <count>'", async () => {
    renderPage();
    await screen.findAllByText("C-02-1C");

    // C-02-1C has byCategory: Plumbing(3, recurring), Electrical(2, non-recurring)
    // Pills render as "<canonical> <count>"
    expect(screen.getAllByText("Plumbing 3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Electrical 2").length).toBeGreaterThan(0);
  });

  it("does NOT show recurring chips for units without recurringCategories — shows byCategory pill instead", async () => {
    setupMocks(0, [
      makeRow({
        unitId: "unit-x",
        unitCode: "X-01-01",
        windowTotal: 5,
        recurringCategories: [],
        byCategory: [{ canonical: "Cleaning", count: 2, isMapped: true, recurring: false }],
      }),
    ]);
    renderPage();
    await screen.findAllByText("X-01-01");
    // Non-recurring unit: pill shows as "<canonical> <count>" (slate tone, not amber)
    expect(screen.getAllByText("Cleaning 2").length).toBeGreaterThan(0);
  });

  it("does NOT render the standalone RecurringProblemsPanel section", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    // The panel heading "Recurring Problems" must NOT appear
    expect(screen.queryByText("Recurring Problems")).toBeNull();
  });

  // Note: the old "Recurring" badge text is no longer rendered as a separate component.
  // Recurring state is conveyed via inline amber chips in the category column.
});

describe("UnitAnalyticsPage — unmapped data-quality nudge", () => {
  it("shows the nudge with 'grouped under Other' copy when unmapped.count > 0", async () => {
    setupMocks(3);
    renderPage();
    await screen.findAllByText("B-10-3A");
    // New copy: grouped under 'Other', not 'excluded'
    expect(screen.getByText(/grouped under/i)).toBeInTheDocument();
    expect(screen.queryByText(/excluded from the category breakdown/i)).toBeNull();
  });

  it("does NOT show the unmapped nudge when unmapped.count === 0", async () => {
    setupMocks(0);
    renderPage();
    await screen.findAllByText("B-10-3A");
    expect(screen.queryByText(/unmapped category/i)).toBeNull();
  });
});

describe("UnitAnalyticsPage — window Segmented triggers refetch", () => {
  it("calls useUnitAnalytics with 90d as default window", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");

    // Default is now 90d
    expect(mockUseUnitAnalytics).toHaveBeenCalledWith(expect.objectContaining({ window: "90d" }));
  });

  it("calls useUnitAnalytics with the new window when Segmented changes", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");

    // Click the "30d" button in the Segmented control (in the Rankings surface actions)
    const btn30d = screen.getByRole("radio", { name: "30d" });
    fireEvent.click(btn30d);

    await waitFor(() => {
      expect(mockUseUnitAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({ window: "30d" }),
      );
    });
  });

  it("calls useCategoryLens with the new window too (useAnalyticsTrend removed with charts)", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");

    const btn12mo = screen.getByRole("radio", { name: "12mo" });
    fireEvent.click(btn12mo);

    await waitFor(() => {
      expect(mockUseCategoryLens).toHaveBeenCalledWith(
        expect.objectContaining({ window: "12mo" }),
      );
    });
  });
});

describe("UnitAnalyticsPage — hero cards", () => {
  it("renders 4 hero metric cards (no empty 4th slot)", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");

    expect(screen.getByText("Open backlog")).toBeInTheDocument();
    expect(screen.getByText("Aging")).toBeInTheDocument();
    expect(screen.getByText("Avg resolve time")).toBeInTheDocument();
    expect(screen.getByText("Repeat-issue units")).toBeInTheDocument();
  });

  it("shows MTTR value formatted to 1 decimal", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    // mttrDays=4.2 → "4.2 days"
    expect(screen.getByText("4.2 days")).toBeInTheDocument();
  });

  it("shows aging as integer days", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    // oldestOpenDays=18.0 → "18 days"
    expect(screen.getByText("18 days")).toBeInTheDocument();
  });

  it("shows — for null MTTR", async () => {
    mockUseUnitAnalytics.mockReturnValue({
      ...makeAnalyticsData(worstFirst),
      data: {
        data: {
          rows: worstFirst,
          unmapped: { count: 0 },
          summary: { mttrDays: null, oldestOpenDays: null, openOver30: 0 },
        },
      },
    });
    renderPage();
    await screen.findAllByText("B-10-3A");
    // Both MTTR and Aging should show —
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("UnitAnalyticsPage — empty state", () => {
  it("shows empty state when API returns zero rows", async () => {
    setupMocks(0, []);
    renderPage();
    await screen.findByText(/No ticket data/i);
  });
});

// ── Task 2 new tests ──────────────────────────────────────────────────────────

// Extended fixture with byCategory data for sort + filter tests
const sortFilterRows: UnitAnalyticsRow[] = [
  makeRow({
    unitId: "sf-1",
    unitCode: "Z-10-1A",
    open: 5,
    windowTotal: 10,
    total: 20,
    byCategory: [
      { canonical: "Plumbing", count: 3, isMapped: true, recurring: true },
      { canonical: "Electrical", count: 2, isMapped: true, recurring: false },
    ],
    recurringCategories: ["Plumbing"],
    topRecurringCategory: "Plumbing",
  }),
  makeRow({
    unitId: "sf-2",
    unitCode: "A-01-2B",
    open: 0,
    windowTotal: 4,
    total: 8,
    byCategory: [
      { canonical: "Electrical", count: 4, isMapped: true, recurring: true },
    ],
    recurringCategories: ["Electrical"],
    topRecurringCategory: "Electrical",
  }),
  makeRow({
    unitId: "sf-3",
    unitCode: "M-05-3C",
    open: 2,
    windowTotal: 7,
    total: 12,
    byCategory: [
      { canonical: "Plumbing", count: 2, isMapped: true, recurring: false },
    ],
    recurringCategories: [],
    topRecurringCategory: null,
  }),
];

describe("UnitAnalyticsPage — sortable columns (Task 2)", () => {
  beforeEach(() => {
    setupMocks(0, sortFilterRows);
  });

  it("defaults to open desc — Z-10-1A (open=5) appears before M-05-3C (open=2)", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");
    const body = document.body.textContent ?? "";
    expect(body.indexOf("Z-10-1A")).toBeLessThan(body.indexOf("M-05-3C"));
  });

  it("clicking the Open header toggles to asc — A-01-2B (open=0) appears first", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const openHeader = screen.getByRole("button", { name: /open/i });
    // First click: already desc, toggles to asc
    fireEvent.click(openHeader);

    await waitFor(() => {
      const body = document.body.textContent ?? "";
      // A-01-2B has open=0, should be first in asc
      expect(body.indexOf("A-01-2B")).toBeLessThan(body.indexOf("Z-10-1A"));
    });
  });

  it("clicking Open header twice returns to desc order", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const openHeader = screen.getByRole("button", { name: /open/i });
    fireEvent.click(openHeader); // toggle to asc
    fireEvent.click(openHeader); // toggle back to desc

    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body.indexOf("Z-10-1A")).toBeLessThan(body.indexOf("A-01-2B"));
    });
  });

  it("clicking In window header sorts by windowTotal desc", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const inWindowHeader = screen.getByRole("button", { name: /in window/i });
    fireEvent.click(inWindowHeader);

    await waitFor(() => {
      const body = document.body.textContent ?? "";
      // Z-10-1A windowTotal=10, M-05-3C=7, A-01-2B=4 — desc: Z first
      expect(body.indexOf("Z-10-1A")).toBeLessThan(body.indexOf("M-05-3C"));
      expect(body.indexOf("M-05-3C")).toBeLessThan(body.indexOf("A-01-2B"));
    });
  });

  it("clicking All-time header sorts by total desc", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const allTimeHeader = screen.getByRole("button", { name: /all-time/i });
    fireEvent.click(allTimeHeader);

    await waitFor(() => {
      const body = document.body.textContent ?? "";
      // total: Z-10-1A=20 > M-05-3C=12 > A-01-2B=8
      expect(body.indexOf("Z-10-1A")).toBeLessThan(body.indexOf("M-05-3C"));
    });
  });
});

describe("UnitAnalyticsPage — Top-problems pills (Task 2)", () => {
  beforeEach(() => {
    setupMocks(0, sortFilterRows);
  });

  it("renders byCategory pills for a unit (not just recurring) — 'Plumbing 3'", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");
    // Z-10-1A has byCategory: Plumbing(3), Electrical(2)
    expect(screen.getAllByText("Plumbing 3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Electrical 2").length).toBeGreaterThan(0);
  });

  it("renders a non-recurring byCategory pill — 'Plumbing 2' for M-05-3C", async () => {
    renderPage();
    await screen.findAllByText("M-05-3C");
    // M-05-3C has Plumbing(2), non-recurring — still shows pill, not '—'
    expect(screen.getAllByText("Plumbing 2").length).toBeGreaterThan(0);
  });

  it("shows '—' only when byCategory is empty", async () => {
    setupMocks(0, [
      makeRow({ unitId: "empty-cat", unitCode: "X-00-00", byCategory: [], recurringCategories: [] }),
    ]);
    renderPage();
    await screen.findAllByText("X-00-00");
    // Should show '—' for top-problems cell since byCategory is empty
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });
});

describe("UnitAnalyticsPage — client-side filters (Task 2)", () => {
  beforeEach(() => {
    setupMocks(0, sortFilterRows);
  });

  it("Category filter: selecting 'Electrical' shows only units whose byCategory includes it", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const categorySelect = screen.getByTestId("category-filter");
    fireEvent.change(categorySelect, { target: { value: "Electrical" } });

    await waitFor(() => {
      // Z-10-1A and A-01-2B have Electrical; M-05-3C does NOT
      expect(screen.queryAllByText("M-05-3C").length).toBe(0);
      expect(screen.queryAllByText("Z-10-1A").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("A-01-2B").length).toBeGreaterThan(0);
    });

    // When Category filter is active, rows sorted by that category's count desc.
    // A-01-2B Electrical count=4 > Z-10-1A Electrical count=2 → A-01-2B renders first.
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body.indexOf("A-01-2B")).toBeLessThan(body.indexOf("Z-10-1A"));
    });
  });

  it("Status filter: Open hides units with open=0", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const statusSelect = screen.getByTestId("status-filter");
    fireEvent.change(statusSelect, { target: { value: "open" } });

    await waitFor(() => {
      // A-01-2B has open=0 — hidden
      expect(screen.queryAllByText("A-01-2B").length).toBe(0);
      // Z-10-1A (open=5) and M-05-3C (open=2) should remain
      expect(screen.queryAllByText("Z-10-1A").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("M-05-3C").length).toBeGreaterThan(0);
    });
  });

  it("Search box: typing a unitCode substring narrows results", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const searchInput = screen.getByTestId("unit-search");
    fireEvent.change(searchInput, { target: { value: "M-05" } });

    await waitFor(() => {
      expect(screen.queryAllByText("Z-10-1A").length).toBe(0);
      expect(screen.queryAllByText("A-01-2B").length).toBe(0);
      expect(screen.queryAllByText("M-05-3C").length).toBeGreaterThan(0);
    });
  });

  it("Category select options include distinct canonicals from all rows", async () => {
    renderPage();
    await screen.findAllByText("Z-10-1A");

    const categorySelect = screen.getByTestId("category-filter") as HTMLSelectElement;
    const options = Array.from(categorySelect.options).map((o) => o.value);
    expect(options).toContain("Plumbing");
    expect(options).toContain("Electrical");
    expect(options).toContain(""); // "All categories" default
  });
});

describe("UnitAnalyticsPage — charts removed (Task 2)", () => {
  it("does NOT render CategoryBars (no 'Top categories' heading)", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    // CategoryBars renders a heading like "Top categories"
    expect(screen.queryByText(/top categories/i)).toBeNull();
  });

  it("does NOT render CreatedVsResolvedChart (no 'Created vs Resolved' heading)", async () => {
    renderPage();
    await screen.findAllByText("B-10-3A");
    expect(screen.queryByText(/created vs resolved/i)).toBeNull();
  });
});
