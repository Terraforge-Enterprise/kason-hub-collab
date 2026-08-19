import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OwnerDashboardPage from "../owner-dashboard";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DASHBOARD_FIXTURE = {
  data: {
    propertyCount: 2,
    totalRentalIncome: 5000,
    totalMaintenanceSpend: 200,
    occupancy: { occupied: 4, total: 5, rate: 0.8 },
    recentTransactions: [
      { id: "t1", tenantName: "Alice Tan", amount: 2500, receivedAt: "2026-06-01" },
    ],
    properties: [
      { id: "prop-1", name: "Skyview Residences", unitCount: 3, occupiedCount: 2 },
      { id: "prop-2", name: "Marina Suites", unitCount: 2, occupiedCount: 2 },
    ],
  },
};

const LEDGER_SUMMARY_FIXTURE = {
  grossRental: "5000.00",
  totalExpenses: "450.00",
  netRentalAfterExpenses: "4550.00",
  netPayoutToOwner: "4400.00",
  byCategory: { management_fee: "350.00", wifi: "100.00" },
};

const LEDGER_ROWS = [
  {
    id: "row-1",
    statementMonth: "2026-06",
    transactionDate: "2026-06-01",
    direction: "income",
    category: "rental",
    description: "Rent — Skyview A-101",
    remarks: null,
    amount: "2500.00",
    sstAmount: null,
    paidBy: "tenant",
    paymentStatus: "paid",
    taxCategory: "gross",
    attachmentKeys: [],
    propertyId: "prop-1",
    apartmentId: "apt-1",
    unitCode: "A-101",
    listingId: null,
  },
  {
    id: "row-2",
    statementMonth: "2026-06",
    transactionDate: "2026-06-01",
    direction: "income",
    category: "rental",
    description: "Rent — Marina B-201",
    remarks: null,
    amount: "2500.00",
    sstAmount: null,
    paidBy: "tenant",
    paymentStatus: "paid",
    taxCategory: "gross",
    attachmentKeys: [],
    propertyId: "prop-2",
    apartmentId: "apt-2",
    unitCode: "B-201",
    listingId: null,
  },
];

const LEDGER_FIXTURE = {
  data: { rows: LEDGER_ROWS, summary: LEDGER_SUMMARY_FIXTURE },
};

// ─── Wrapper ──────────────────────────────────────────────────────────────────

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OwnerDashboardPage", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
    // Default: /dashboard returns the dashboard fixture; /owner-ledger returns ledger.
    portalApiFetch.mockImplementation((path: string) => {
      if (path === "/dashboard") return Promise.resolve(DASHBOARD_FIXTURE);
      if (path.startsWith("/owner-ledger")) return Promise.resolve(LEDGER_FIXTURE);
      return Promise.resolve({ data: {} });
    });
  });

  it("renders KPI GlowCards with formatted values from useOwnerLedger summary", async () => {
    render(wrap(<OwnerDashboardPage />));

    // Wait for dashboard to load (headline)
    await screen.findByText("Portfolio Overview");

    // KPI card labels
    expect(screen.getByText("Gross Rental")).toBeInTheDocument();
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getByText("Net Payout")).toBeInTheDocument();
    expect(screen.getByText("Occupancy")).toBeInTheDocument();

    // Formatted money values from ledger summary
    expect(await screen.findByText("RM 5,000.00")).toBeInTheDocument();
    expect(screen.getByText("RM 450.00")).toBeInTheDocument();
    expect(screen.getByText("RM 4,400.00")).toBeInTheDocument();

    // Occupancy from dashboard data (4/5 = 80%)
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("4/5 units occupied")).toBeInTheDocument();
  });

  it("renders secondary KPI cards: latest statement month", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(screen.getByText("Latest Statement")).toBeInTheDocument();
    expect(await screen.findByText("2026-06")).toBeInTheDocument();
  });

  it("renders 'Download Annual Report' link to /portal/income-tax", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    const link = await screen.findByRole("link", { name: /download annual report/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/portal/income-tax");
  });

  it("shows property selector when multiple properties exist", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    const propertySelect = screen.getByRole("combobox", { name: /filter by property/i });
    expect(propertySelect).toBeInTheDocument();
    expect(propertySelect).toHaveValue("");

    // Options: All + 2 properties
    const options = propertySelect.querySelectorAll("option");
    expect(options).toHaveLength(3);
    expect(options[1]).toHaveTextContent("Skyview Residences");
    expect(options[2]).toHaveTextContent("Marina Suites");
  });

  it("changing From month triggers a refetch of useOwnerLedger with new range", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    const fromInput = screen.getByLabelText(/from month/i);

    // Reset mock count after initial calls
    portalApiFetch.mockClear();

    // Change from month
    fireEvent.change(fromInput, { target: { value: "2026-03" } });

    await waitFor(() => {
      // portalApiFetch should have been called with the new fromMonth in the URL
      const calls = (portalApiFetch.mock.calls as unknown[][]).filter(
        (args) => typeof args[0] === "string" && (args[0] as string).includes("/owner-ledger"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = calls[calls.length - 1][0] as string;
      expect(lastCall).toContain("fromMonth=2026-03");
    });
  });

  it("changing To month triggers a refetch with new range", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    const toInput = screen.getByLabelText(/to month/i);

    portalApiFetch.mockClear();

    fireEvent.change(toInput, { target: { value: "2026-05" } });

    await waitFor(() => {
      const calls = (portalApiFetch.mock.calls as unknown[][]).filter(
        (args) => typeof args[0] === "string" && (args[0] as string).includes("/owner-ledger"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const lastCall = calls[calls.length - 1][0] as string;
      expect(lastCall).toContain("toMonth=2026-05");
    });
  });

  it("shows per-property breakdown toggle when multiple properties have rows", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    // Breakdown section title appears
    const breakdownTitle = await screen.findByText("Per-Property Breakdown");
    expect(breakdownTitle).toBeInTheDocument();

    // Find and click the toggle button (closest button ancestor)
    const breakdownHeader = breakdownTitle.closest("button");
    expect(breakdownHeader).not.toBeNull();
    if (breakdownHeader) fireEvent.click(breakdownHeader);

    await waitFor(() => {
      // Property names should appear in the expanded breakdown cards
      expect(screen.getAllByText("Skyview Residences").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Marina Suites").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows properties list from dashboard data", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    // Property list in the lower section
    const propertyItems = await screen.findAllByText("Skyview Residences");
    expect(propertyItems.length).toBeGreaterThanOrEqual(1);
    const marinaItems = await screen.findAllByText("Marina Suites");
    expect(marinaItems.length).toBeGreaterThanOrEqual(1);
  });

  it("shows recent transactions from dashboard data", async () => {
    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(await screen.findByText("Alice Tan")).toBeInTheDocument();
  });
});

// ─── Ledger grouping (owner-ledger view clarity, Task 5) ──────────────────────
//
// Separate describe block + local mockLedger() helper so these fixtures never
// interfere with the KPI/property/recent-transactions tests above (which rely
// on the shared LEDGER_FIXTURE / LEDGER_ROWS staying exactly as-is).

function mockLedgerRows(rows: unknown[], summary: unknown = LEDGER_SUMMARY_FIXTURE) {
  portalApiFetch.mockImplementation((path: string) => {
    if (path === "/dashboard") return Promise.resolve(DASHBOARD_FIXTURE);
    if (path.startsWith("/owner-ledger")) return Promise.resolve({ data: { rows, summary } });
    return Promise.resolve({ data: {} });
  });
}

describe("portal owner dashboard ledger grouping (Task 5)", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
  });

  it("groups Income/Expenses with status pills + Callout, distinguishing Deducted vs Owner-paid", async () => {
    mockLedgerRows([
      {
        id: "g-income-1",
        statementMonth: "2026-06",
        transactionDate: "2026-06-01",
        direction: "income",
        category: "rental_income",
        description: "June rent — Unit A-101",
        remarks: null,
        amount: "1200.00",
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "not_applicable",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
      {
        id: "g-expense-deducted",
        statementMonth: "2026-06",
        transactionDate: "2026-06-05",
        direction: "expense",
        category: "utilities_tnb",
        description: "TNB — June",
        remarks: null,
        amount: "120.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "pending",
        taxCategory: "utilities",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
      {
        id: "g-expense-ownerpaid",
        statementMonth: "2026-06",
        transactionDate: "2026-06-06",
        direction: "expense",
        category: "repairs",
        description: "Aircond repair",
        remarks: null,
        amount: "80.00",
        sstAmount: null,
        paidBy: "owner",
        paymentStatus: "paid",
        taxCategory: "rental_expense",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: false,
      },
    ]);

    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(await screen.findByText(/Income \(money in\)/)).toBeInTheDocument();
    expect(screen.getByText(/Expenses \(paid by KAEN/)).toBeInTheDocument();
    expect(screen.getByText(/full supplier bill/)).toBeInTheDocument();
    expect(screen.getByText("Deducted")).toBeInTheDocument();
    expect(screen.getByText("Owner-paid")).toBeInTheDocument();
  });

  // groupByDirection returns ONLY {income, expenses} — it silently drops
  // payout-direction rows. The portal getOwnerLedgerRows query has no `direction`
  // filter, so a recorded payout (created via the admin "Record Payout" action,
  // direction:"payout") reaches this same list. This test proves payout rows are
  // carved out into their own section instead of disappearing, and — critically —
  // that their status is resolved via getStatusTone/labelFor, NOT
  // ownerLedgerRowStatus (whose non-income branch reads includeInPayout, which a
  // real payout row always sets to false — same as an owner-paid expense — and
  // would mislabel the payout "Owner-paid").
  it("renders payout-direction rows in a separate Payouts section, not mislabeled Owner-paid", async () => {
    mockLedgerRows([
      {
        id: "g-income-2",
        statementMonth: "2026-06",
        transactionDate: "2026-06-01",
        direction: "income",
        category: "rental_income",
        description: "June rent",
        remarks: null,
        amount: "500.00",
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "not_applicable",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
      {
        id: "g-expense-2",
        statementMonth: "2026-06",
        transactionDate: "2026-06-05",
        direction: "expense",
        category: "utilities_tnb",
        description: "TNB — June",
        remarks: null,
        amount: "50.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "utilities",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
      {
        id: "g-payout-1",
        statementMonth: "2026-06",
        transactionDate: "2026-06-28",
        direction: "payout",
        category: "owner_payout",
        description: null,
        remarks: "Bank transfer",
        amount: "1000.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "pending",
        taxCategory: "not_applicable",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: false,
      },
    ]);

    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(await screen.findByText("Payouts")).toBeInTheDocument();
    expect(screen.getByText("RM 1,000.00")).toBeInTheDocument();
    // Correct path: getStatusTone("pending")/labelFor("pending") → "Pending".
    expect(screen.getByText("Pending")).toBeInTheDocument();
    // Regression guard: ownerLedgerRowStatus would have rendered this as
    // "Owner-paid" (direction!=="income" && includeInPayout===false).
    expect(screen.queryByText("Owner-paid")).not.toBeInTheDocument();
  });

  it("hides the Expenses and Payouts sections (and the Callout) when the range has income-only rows", async () => {
    mockLedgerRows([
      {
        id: "g-income-only",
        statementMonth: "2026-06",
        transactionDate: "2026-06-01",
        direction: "income",
        category: "rental_income",
        description: "June rent",
        remarks: null,
        amount: "900.00",
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "not_applicable",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
    ]);

    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(await screen.findByText(/Income \(money in\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Expenses \(paid by KAEN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/full supplier bill/)).not.toBeInTheDocument();
    expect(screen.queryByText("Payouts")).not.toBeInTheDocument();
  });

  it("hides the Income section when the range has expense-only rows", async () => {
    mockLedgerRows([
      {
        id: "g-expense-only",
        statementMonth: "2026-06",
        transactionDate: "2026-06-05",
        direction: "expense",
        category: "management_fee",
        description: "Mgmt fee",
        remarks: null,
        amount: "60.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "rental_expense",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: null,
        listingId: null,
        includeInPayout: true,
      },
    ]);

    render(wrap(<OwnerDashboardPage />));
    await screen.findByText("Portfolio Overview");

    expect(await screen.findByText(/Expenses \(paid by KAEN/)).toBeInTheDocument();
    expect(screen.queryByText(/Income \(money in\)/)).not.toBeInTheDocument();
  });
});
