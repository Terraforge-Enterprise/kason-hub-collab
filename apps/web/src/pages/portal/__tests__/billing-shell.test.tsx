import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
  renderHook,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

// Task 5 — Billing shell + Overview tab + shared data hooks.
// Mirrors apps/web/src/pages/portal/__tests__/payments.test.tsx: mock
// @/lib/portal-api, native matchers only (no jest-dom — toBeTruthy/toBeNull/
// toHaveLength), QueryClientProvider (retry:false) + MemoryRouter.

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
  PortalApiError: class PortalApiError extends Error {},
}));

import PortalBillingPage from "../billing";
import {
  useDashboard,
  usePortalCharges,
  usePortalPayments,
} from "../billing/use-billing-data";

// --- Fixtures ---------------------------------------------------------------
// Numbers match Appendix A §3 wireframe exactly (2260 - 960 - 1200 = 100) so
// "Amount to pay RM 100.00" traces straight back to the spec's own example.

const BASE_DASHBOARD = {
  data: {
    tenant: { displayName: "Jane Tan", partyType: "tenant" },
    lease: {
      tenancyCode: "TC-0001",
      unitCode: "A-12-03",
      propertyName: "Kaen Residences",
      startDate: "2026-01-01",
      endDate: null,
      monthlyRentAmount: 1200,
      status: "active",
    },
    upcomingCharges: [
      {
        id: "chg-next",
        chargeNumber: "IVTEN-0008",
        chargeType: "Utility balance",
        amount: 100,
        dueDate: "2026-08-01",
        status: "posted",
      },
    ],
    recentPayments: [],
    announcements: [],
    attention: { pendingVerificationPayments: [], rejectedPayments: [], hasMoreUnresolvedPayments: false },
    balance: {
      totalCharges: 2260,
      totalPayments: 1200,
      totalCredits: 960,
      netBalance: 100,
      unpaidCount: 1,
      overdueAmount: 0,
      overdueCount: 0,
      creditAvailable: 0,
      currency: "MYR",
    },
  },
};

const EMPTY_CHARGES = {
  data: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
};

const OVERDUE_CHARGE = {
  id: "chg-overdue",
  chargeNumber: "IVTEN-0007",
  chargeType: "Rent",
  description: "April rent",
  status: "posted",
  dueDate: "2020-01-01",
  amount: 1200,
  outstandingAmount: 1200,
  currency: "MYR",
};

const CHARGES_WITH_OVERDUE = {
  data: [OVERDUE_CHARGE],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const EMPTY_PAYMENTS = {
  data: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 1 },
};

/** BASE_DASHBOARD with `balance` fields overridden — for the server-side aggregates. */
function withBalance(over: Record<string, number>) {
  return { data: { ...BASE_DASHBOARD.data, balance: { ...BASE_DASHBOARD.data.balance, ...over } } };
}

function mockApi(overrides: { charges?: unknown; dashboard?: unknown } = {}) {
  portalApiFetch.mockImplementation((path: string) => {
    if (path.startsWith("/dashboard")) return Promise.resolve(overrides.dashboard ?? BASE_DASHBOARD);
    if (path.startsWith("/charges")) return Promise.resolve(overrides.charges ?? EMPTY_CHARGES);
    if (path.startsWith("/payments")) return Promise.resolve(EMPTY_PAYMENTS);
    return Promise.reject(new Error(`unexpected portalApiFetch path: ${path}`));
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <PortalBillingPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  portalApiFetch.mockReset();
  mockApi();
});

describe("PortalBillingPage — shell + Overview tab", () => {
  it("overview default — no ?tab= renders Overview active with Amount to pay RM 100.00", async () => {
    renderAt("/portal/billing");

    const tablist = await screen.findByRole("tablist");
    const overviewTab = within(tablist).getByRole("tab", { name: "Overview" });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");

    expect(await screen.findByText("Amount to pay")).toBeTruthy();
    expect(screen.getAllByText("RM 100.00").length).toBeGreaterThan(0);
  });

  it("tab deep link — clicking Payments updates the URL and shows the Payments tab (T7)", async () => {
    renderAt("/portal/billing");

    const tablist = await screen.findByRole("tablist");
    fireEvent.click(within(tablist).getByRole("tab", { name: "Payments" }));

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toBe("?tab=payments");
    });
    expect(within(tablist).getByRole("tab", { name: "Payments" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    // T7 replaced the "Coming in T7" placeholder with the real PaymentsTab;
    // this fixture's mockApi() returns EMPTY_PAYMENTS, so the tab renders its
    // EmptyState rather than a placeholder string.
    expect(await screen.findByText(/no payments yet/i)).toBeTruthy();
  });

  it("breakdown — Overview renders Total billed / Credits / Payments received lines", async () => {
    renderAt("/portal/billing");

    expect(await screen.findByText(/total billed/i)).toBeTruthy();
    expect(screen.getByText(/credits/i)).toBeTruthy();
    expect(screen.getByText(/payments received/i)).toBeTruthy();
  });

  it("statements hidden — the tab bar never renders a Statements tab", async () => {
    renderAt("/portal/billing");

    const tablist = await screen.findByRole("tablist");
    expect(within(tablist).queryByText(/statements/i)).toBeNull();
    expect(within(tablist).getAllByRole("tab")).toHaveLength(3);
  });

  // The overdue TOTAL is the server's `balance.overdueAmount`, NOT a sum over
  // `usePortalCharges(1)`. Summing page 1 of 20 short-changed any tenant with
  // more than 20 charges, and the client-side predicate required
  // status === "posted", dropping partially-paid rows still overdue for their
  // remainder. The page-1 list is now used only to NAME the first overdue
  // charge — a label, not a figure.
  it("overdue card — reads the server aggregate, not a page of charges", async () => {
    mockApi({
      charges: CHARGES_WITH_OVERDUE,
      dashboard: withBalance({ overdueAmount: 9800, overdueCount: 31 }),
    });
    renderAt("/portal/billing");

    expect(await screen.findByText("RM 9,800.00")).toBeTruthy();
    // The RM1,200 page-1 row must NOT be presented as the overdue total.
    expect(screen.queryByText("RM 1,200.00")).toBeNull();
    // ...but it still supplies the label under the figure.
    expect(screen.getByText("April rent")).toBeTruthy();
  });

  it("overdue card — falls back to a count when page 1 holds no overdue row", async () => {
    mockApi({ dashboard: withBalance({ overdueAmount: 9800, overdueCount: 31 }) });
    renderAt("/portal/billing");

    expect(await screen.findByText("RM 9,800.00")).toBeTruthy();
    expect(screen.getByText("31 charges past due")).toBeTruthy();
  });

  it("header cards — Current balance / Overdue / Next due render with formatted values", async () => {
    renderAt("/portal/billing");

    expect(await screen.findByText("Current balance")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Next due")).toBeTruthy();
    // formatDateMY("2026-08-01") — Appendix A §3 wireframe shows "1 Aug 2026".
    expect(screen.getByText("1 Aug 2026")).toBeTruthy();
  });
});

describe("use-billing-data — shared query hooks", () => {
  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  it("useDashboard fetches /dashboard with queryKey ['portal-dashboard']", async () => {
    portalApiFetch.mockResolvedValue(BASE_DASHBOARD);
    const { result } = renderHook(() => useDashboard(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(portalApiFetch).toHaveBeenCalledWith("/dashboard");
  });

  it("usePortalCharges(page) fetches /charges?page=&limit=20 with queryKey ['portal-charges', page]", async () => {
    portalApiFetch.mockResolvedValue(EMPTY_CHARGES);
    const { result } = renderHook(() => usePortalCharges(2), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(portalApiFetch).toHaveBeenCalledWith("/charges?page=2&limit=20");
  });

  it("usePortalPayments(page) fetches /payments?page=&limit=20 with queryKey ['portal-payments', page]", async () => {
    portalApiFetch.mockResolvedValue(EMPTY_PAYMENTS);
    const { result } = renderHook(() => usePortalPayments(3), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(portalApiFetch).toHaveBeenCalledWith("/payments?page=3&limit=20");
  });
});
