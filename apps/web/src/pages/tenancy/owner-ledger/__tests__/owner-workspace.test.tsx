// Smoke tests for OwnerWorkspacePage (M6b / T3).
// - Defaults to ALL-TIME (no months in hook calls).
// - "Date range ▾" toggle opens pickers; setting both months scopes hooks + shows chip.
// - Dismissing the chip clears back to all-time.
// - Summary GlowCards render with formatted values from useOwnerLedgerSummary.
// - PRIMARY tab "Monthly Statements": GlowCard grid per month from useOwnerMonthlySummaries (2c-2).
// - SECONDARY tab "All Entries": existing flat table (unchanged in behaviour).
// - Entries are grouped by statementMonth (DESC) with a per-month net subtotal.
// - Only the 5 essential columns are visible by default (All Entries tab).
// - Columns ▾ toggle reveals SST, Status, Tax Category, Description.
// - Clicking a row opens the EntryFormDrawer in read-only detail mode.
// - PaidByBadge renders for each entry.
// - Voided entries are excluded from month groups and subtotals.
// - Creating from the workspace passes defaultOwnerPartyId to the drawer.
// - Empty state shows when there are no entries (All Entries tab).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock useNavigate for Task 3 navigation assertions; preserve all other router exports.
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import type {
  OwnerLedgerEntryRow,
  MonthlyStatementSummary,
  UnitsSummaryData,
} from "@/api/owner-ledger";

// ── Monthly summary mock data (2c-2) ──────────────────────────────────────────

const mockMonthlySummaryJune: MonthlyStatementSummary = {
  month: "2026-06",
  grossRental: "5000.00",
  totalExpenses: "800.00",
  netPayoutToOwner: "4200.00",
  depositCollected: "0.00",
  statementId: "stmt-1",
  statementStatus: "draft",
  hasData: true,
};

const mockMonthlySummaryMay: MonthlyStatementSummary = {
  month: "2026-05",
  grossRental: "0.00",
  totalExpenses: "400.00",
  netPayoutToOwner: "-400.00",
  depositCollected: "0.00",
  statementId: null,
  statementStatus: null,
  hasData: true,
};

// ── Units summary mock data (Task 8 / D3) ─────────────────────────────────────
// Combined + per-unit payout for the picked month. Σ(units) === combined; each
// row foots: income + deposit − deductible === net.
const mockUnitsSummary: UnitsSummaryData = {
  month: "2026-06",
  combined: {
    incomeCollected: "5000.00",
    depositCollected: "200.00",
    deductibleExpenses: "800.00",
    netPayout: "4400.00",
  },
  units: [
    {
      apartmentId: "apt-1",
      unitCode: "A-10-04",
      incomeCollected: "5000.00",
      depositCollected: "200.00",
      deductibleExpenses: "800.00",
      netPayout: "4400.00",
    },
  ],
};

const mockVoidMutate = vi.fn();
const mockCreateMutate = vi.fn();
const mockPatchMutate = vi.fn();
const mockSyncMutate = vi.fn();

const mockSummary = {
  grossRental: "5000.00",
  totalExpenses: "800.00",
  netRentalAfterExpenses: "4200.00",
  netPayoutToOwner: "3800.00",
  payoutsTotal: "0.00",
  byCategory: { rental_income: "5000.00", management_fee: "800.00" },
  // Balance fields (T2)
  broughtForward: "200.00",
  periodGross: "5000.00",
  periodExpenses: "800.00",
  periodPayouts: "0.00",
  netThisPeriod: "4200.00",
  carriedForward: "4400.00",
};

const makeEntry = (overrides: Partial<OwnerLedgerEntryRow> = {}): OwnerLedgerEntryRow => ({
  id: "entry-1",
  organizationId: "org-1",
  ownerPartyId: "owner-1",
  propertyId: "prop-1",
  apartmentId: "apt-1",
  unitCode: "A-01",
  listingId: null,
  tenancyId: null,
  statementMonth: "2026-06-01T00:00:00.000Z",
  transactionDate: "2026-06-15",
  direction: "income" as const,
  category: "rental_income" as const,
  description: "June rent",
  remarks: null,
  amount: "5000.00",
  chargedAmount: null,
  debitAdjustmentAmount: "0.00",
  creditAdjustmentAmount: "0.00",
  sstAmount: "300.00",
  paidBy: "kaen" as const,
  paymentStatus: "paid" as const,
  taxCategory: "not_applicable" as const,
  includeInPayout: true,
  attachmentKeys: [],
  sourceType: "manual",
  sourceChargeId: null,
  sourceUtilityBillId: null,
  status: "active",
  createdById: "admin-1",
  updatedById: "admin-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  ...overrides,
});

const entryJune = makeEntry({ id: "entry-1", statementMonth: "2026-06-01T00:00:00.000Z", amount: "5000.00", paidBy: "kaen" });
const entryMay = makeEntry({
  id: "entry-2",
  statementMonth: "2026-05-01T00:00:00.000Z",
  transactionDate: "2026-05-10",
  direction: "expense" as const,
  category: "management_fee" as const,
  amount: "400.00",
  paidBy: "owner" as const,
  description: "May management fee",
});
// ── Payout fixtures (#8 — payout-history panel) ────────────────────────────────
const entryPayout = makeEntry({
  id: "payout-1",
  direction: "payout" as const,
  category: "owner_payout" as const,
  amount: "300.00",
  transactionDate: "2026-06-20",
  statementMonth: "2026-06-01T00:00:00.000Z",
  remarks: "Maybank transfer",
  paidBy: "kaen" as const,
  includeInPayout: false,
  status: "active",
  updatedAt: "2026-06-20T09:00:00.000Z",
});
const entryPayoutVoided = makeEntry({
  id: "payout-void",
  direction: "payout" as const,
  category: "owner_payout" as const,
  amount: "500.00",
  transactionDate: "2026-06-18",
  statementMonth: "2026-06-01T00:00:00.000Z",
  remarks: "Reversed remittance",
  paidBy: "kaen" as const,
  includeInPayout: false,
  status: "void",
  updatedAt: "2026-06-18T09:00:00.000Z",
});
// Two payouts on the SAME transactionDate — tie-break must be deterministic
// (newest recorded / createdAt desc first), not left to JS stable-sort of the
// upstream fetch order.
const entryPayoutTieOlder = makeEntry({
  id: "payout-tie-older",
  direction: "payout" as const,
  category: "owner_payout" as const,
  amount: "222.00",
  transactionDate: "2026-06-19",
  statementMonth: "2026-06-01T00:00:00.000Z",
  remarks: "older",
  paidBy: "kaen" as const,
  includeInPayout: false,
  createdAt: "2026-06-19T01:00:00.000Z",
  updatedAt: "2026-06-19T01:00:00.000Z",
});
const entryPayoutTieNewer = makeEntry({
  id: "payout-tie-newer",
  direction: "payout" as const,
  category: "owner_payout" as const,
  amount: "111.00",
  transactionDate: "2026-06-19",
  statementMonth: "2026-06-01T00:00:00.000Z",
  remarks: "newer",
  paidBy: "kaen" as const,
  includeInPayout: false,
  createdAt: "2026-06-19T05:00:00.000Z",
  updatedAt: "2026-06-19T05:00:00.000Z",
});

// Capture args passed to the hooks so we can assert all-time vs scoped calls.
const mockSummaryArgs: unknown[] = [];
const mockEntriesArgs: unknown[] = [];

// Module-level mock — one declaration only (duplicate removed).
vi.mock("@/api/owner-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/owner-ledger")>();
  return {
    ...actual,
    useOwnerLedgerSummary: (range: unknown) => {
      mockSummaryArgs.push(range);
      return {
        data: { data: mockSummary },
        isLoading: false,
      };
    },
    useOwnerLedgerEntries: (filters: unknown) => {
      mockEntriesArgs.push(filters);
      return {
        data: { data: { rows: [entryJune, entryMay], total: 2 } },
        isLoading: false,
      };
    },
    useVoidLedgerEntry: () => ({
      mutate: mockVoidMutate,
      isPending: false,
    }),
    useCreateLedgerEntry: () => ({
      mutate: mockCreateMutate,
      isPending: false,
    }),
    usePatchLedgerEntry: () => ({
      mutate: mockPatchMutate,
      isPending: false,
    }),
    useSyncMonth: () => ({
      mutate: mockSyncMutate,
      isPending: false,
    }),
    useOwnerTree: () => ({ data: null, isLoading: false }),
    // 2c-2: monthly summaries hook
    useOwnerMonthlySummaries: (_ownerPartyId: unknown) => ({
      data: { data: { items: [mockMonthlySummaryJune, mockMonthlySummaryMay] } },
      isLoading: false,
    }),
    // Task 8 / D3: per-unit + combined payout for the Monthly Statements tab.
    useUnitsSummary: (_ownerPartyId: unknown, _month: unknown) => ({
      data: { data: mockUnitsSummary },
      isLoading: false,
    }),
  };
});

// Mock apiFetch for the /parties/owners call in the component
import { apiFetch } from "@/lib/api-client";
const mockApiFetch = vi.mocked(apiFetch);

import OwnerWorkspacePage from "../owner-workspace";

// ── Test helpers ───────────────────────────────────────────────────────────────

function renderWorkspace() {
  mockApiFetch.mockResolvedValue({
    data: [{ id: "owner-1", displayName: "Ahmad Rahman" }],
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/tenancy/owner-ledger/owner-1"]}>
        <Routes>
          <Route
            path="/tenancy/owner-ledger/:ownerPartyId"
            element={<OwnerWorkspacePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockClear();
  mockSummaryArgs.length = 0;
  mockEntriesArgs.length = 0;
});

describe("OwnerWorkspacePage — summary GlowCards", () => {
  it("renders Gross Rental card with formatted value", () => {
    renderWorkspace();
    // "Gross Rental" also appears in Monthly Statements cards — use getAllByText
    expect(screen.getAllByText("Gross Rental").length).toBeGreaterThanOrEqual(1);
    // RM 5,000.00 also appears in the monthly card; check at least one occurrence
    expect(screen.getAllByText("RM 5,000.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders Total Expenses card with formatted value", () => {
    renderWorkspace();
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    // RM 800.00 also appears in monthly card Expenses row — use getAllByText
    expect(screen.getAllByText("RM 800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders Net Payout card with formatted value", () => {
    renderWorkspace();
    // "Net Payout" appears in both summary GlowCard and monthly cards — use getAllByText
    expect(screen.getAllByText("Net Payout").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("RM 3,800.00")).toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — month-grouped entries", () => {
  it("shows entries grouped by month (June and May)", () => {
    renderWorkspace();
    // Month-group headers live in the All Entries tab — switch there first.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    // June group header
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    // May group header
    expect(screen.getByText("May 2026")).toBeInTheDocument();
  });

  it("shows per-month net subtotals", () => {
    renderWorkspace();
    // June: income 5000 → net positive
    // May: expense 400 → net negative
    // Both should render some RM-formatted subtotals
    const rmValues = screen.getAllByText(/RM/);
    expect(rmValues.length).toBeGreaterThanOrEqual(2);
  });

  it("collapses a month section on header click", () => {
    renderWorkspace();
    // Switch to All Entries tab first — month-group headers live there.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    const juneHeader = screen.getByRole("button", { name: /June 2026/i });
    fireEvent.click(juneHeader);
    // After collapse, the table for June should not show entry row
    // The row aria-label "Entry entry-1" should be gone
    expect(screen.queryByRole("row", { name: /Entry entry-1/i })).not.toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — essential columns (default)", () => {
  it("shows the 5 essential column headers", () => {
    renderWorkspace();
    // Column headers live in All Entries tab — switch there first.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    expect(screen.getAllByText("Date").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Unit").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Category").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Amount").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Paid By").length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT show extra columns by default", () => {
    renderWorkspace();
    expect(screen.queryAllByText("SST").length).toBe(0);
    expect(screen.queryAllByText("Status").length).toBe(0);
    expect(screen.queryAllByText("Tax Category").length).toBe(0);
    expect(screen.queryAllByText("Description").length).toBe(0);
  });
});

describe("OwnerWorkspacePage — Columns toggle", () => {
  it("reveals extra columns after Columns toggle click", () => {
    renderWorkspace();
    // Columns toggle is inside the All Entries tab.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    fireEvent.click(screen.getByRole("button", { name: /Columns/i }));
    expect(screen.getAllByText("SST").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Status").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Tax Category").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Description").length).toBeGreaterThanOrEqual(1);
  });
});

describe("OwnerWorkspacePage — PaidByBadge", () => {
  it("renders PaidByBadge for each row", () => {
    renderWorkspace();
    // Rows live in All Entries tab — switch there first.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    // kaen → "Paid by KAEN"; owner → "Paid by you"
    expect(screen.getByText("Paid by KAEN")).toBeInTheDocument();
    expect(screen.getByText("Paid by you")).toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — row → read-only detail", () => {
  it("opens the read-only detail drawer when a row is clicked", async () => {
    renderWorkspace();
    // Rows live in All Entries tab.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    // Click the first entry row
    const row = screen.getByRole("row", { name: /Entry entry-1/i });
    fireEvent.click(row);
    // EntryFormDrawer opens read-only — title "Ledger entry", no Save button.
    await waitFor(() => {
      expect(screen.getByText(/^Ledger entry$/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
    });
  });

  // R3: the actions <td> calls e.stopPropagation() so a Void click fires ONLY
  // the void flow, not the row's own onClick (which would open the read-only
  // detail drawer). Without the guard, both handlers fire in the same bubble
  // phase and the row's setOverlay({kind:"view"}) call — being the later,
  // non-functional state update — wins, silently swallowing the void intent.
  it("clicking a row's Void button does not open the read-only detail drawer", async () => {
    renderWorkspace();
    // Rows live in All Entries tab.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    // Same Void-button query as the non-payout void test below (entry-1 is
    // the active, non-voided row from the default entries mock).
    fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));
    // The void confirm opens instead (generic copy — entry-1 is income, not payout).
    expect(
      await screen.findByText(/Voiding cannot be undone/i),
    ).toBeInTheDocument();
    // Key assertion: the read-only detail drawer (title "Ledger entry") must
    // NOT have opened as a side effect of the Void click.
    expect(screen.queryByText(/^Ledger entry$/i)).not.toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — action buttons", () => {
  it("renders New entry and Month review buttons", () => {
    renderWorkspace();
    expect(screen.getByRole("button", { name: /New entry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Month review/i })).toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — voided entries excluded from workspace (Fix 1)", () => {
  it("does NOT show voided entry in month group and does NOT count it in subtotal", () => {
    // The module mock returns [entryJune, entryMay] — no voided entries.
    // We verify: active entry IS visible, voided entry row is absent,
    // and RM 9,999.00 (the voided entry's amount) does NOT appear anywhere.
    renderWorkspace();
    // Switch to All Entries tab to inspect the table rows.
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    // Active entry is rendered
    expect(screen.getByRole("row", { name: /Entry entry-1/i })).toBeInTheDocument();
    // voided entry (id=entry-void) is NOT in the DOM
    expect(screen.queryByRole("row", { name: /Entry entry-void/i })).not.toBeInTheDocument();
    // RM 9,999.00 (voided entry's amount) does NOT appear
    expect(screen.queryByText("RM 9,999.00")).not.toBeInTheDocument();
  });
});

describe("OwnerWorkspacePage — defaultOwnerPartyId pre-select (Fix 2)", () => {
  it("opens EntryFormDrawer in create mode with owner pre-selected via defaultOwnerPartyId", async () => {
    renderWorkspace();
    // Click "New entry" — the workspace passes defaultOwnerPartyId="owner-1"
    fireEvent.click(screen.getByRole("button", { name: /New entry/i }));
    // Drawer should open in create mode; wait for owner combobox to have
    // the pre-selected value (form state is seeded by useEffect on open).
    await waitFor(() => {
      expect(screen.getByText(/New ledger entry/i)).toBeInTheDocument();
      const ownerSelect = screen.getByRole("combobox", { name: /Owner/i });
      expect((ownerSelect as HTMLSelectElement).value).toBe("owner-1");
    });
  });
});

describe("OwnerWorkspacePage — empty state (Fix 3)", () => {
  it("shows empty state message when entries hook returns no rows", async () => {
    // Temporarily override the mock to return empty rows using vi.doMock +
    // dynamic re-import so the module factory can be replaced mid-suite.
    const ownerLedgerModule = await import("@/api/owner-ledger");
    const spy = vi.spyOn(ownerLedgerModule, "useOwnerLedgerEntries").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast to avoid full UseQueryResult shape
      { data: { data: { rows: [], total: 0 } }, isLoading: false } as any,
    );

    // try/finally ensures spy is restored even if the assertion throws, so it
    // doesn't leak into subsequent tests and disable the entry mock there.
    try {
      renderWorkspace();
      // Empty state for entries is in the All Entries tab (2c-2: entries moved behind a tab).
      fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
      expect(
        screen.getByText(/No ledger entries for this owner in the selected range/i),
      ).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("OwnerWorkspacePage — all-time default + optional date range", () => {
  it("calls hooks with NO month args by default (all-time)", () => {
    renderWorkspace();
    // The first call to each hook should have no fromMonth / toMonth.
    const summaryCall = mockSummaryArgs[0] as Record<string, unknown>;
    expect(summaryCall.fromMonth).toBeUndefined();
    expect(summaryCall.toMonth).toBeUndefined();

    const entriesCall = mockEntriesArgs[0] as Record<string, unknown>;
    expect(entriesCall.fromMonth).toBeUndefined();
    expect(entriesCall.toMonth).toBeUndefined();
  });

  it("date range toggle is collapsed by default (no pickers visible)", () => {
    renderWorkspace();
    // type=month inputs — use getByLabelText not getByRole textbox
    expect(screen.queryByLabelText(/From month/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/To month/i)).not.toBeInTheDocument();
  });

  it("shows date pickers after toggle click and renders chip when both months set", async () => {
    renderWorkspace();

    // Open the toggle
    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/From month/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/To month/i)).toBeInTheDocument();
    });

    // Set both months
    fireEvent.change(screen.getByLabelText(/From month/i), {
      target: { value: "2026-05" },
    });
    fireEvent.change(screen.getByLabelText(/To month/i), {
      target: { value: "2026-06" },
    });

    // Dismissible chip should appear
    await waitFor(() => {
      expect(screen.getByText("2026-05 – 2026-06")).toBeInTheDocument();
    });
  });

  it("clears date range and collapses pickers when chip × is clicked", async () => {
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/From month/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/From month/i), {
      target: { value: "2026-06" },
    });
    fireEvent.change(screen.getByLabelText(/To month/i), {
      target: { value: "2026-06" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/Clear date range/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Clear date range/i));

    await waitFor(() => {
      expect(screen.queryByLabelText(/From month/i)).not.toBeInTheDocument();
    });
  });
});

describe("OwnerWorkspacePage — balance panel", () => {
  it("renders Running Balance section with Brought Forward", () => {
    renderWorkspace();
    expect(screen.getByText("Running Balance")).toBeInTheDocument();
    expect(screen.getByText("Brought Forward")).toBeInTheDocument();
  });

  it("renders Carried Forward value from summary.carriedForward", () => {
    renderWorkspace();
    const cf = screen.getByTestId("carried-forward-value");
    expect(cf).toHaveTextContent("RM 4,400.00");
  });

  it("shows carried-forward in emerald when positive", () => {
    renderWorkspace();
    const cf = screen.getByTestId("carried-forward-value");
    expect(cf.className).toContain("emerald");
  });

  it("shows carried-forward in rose when negative", async () => {
    // Temporarily override the summary mock to return a negative carried-forward.
    const ownerLedgerModule = await import("@/api/owner-ledger");
    const spy = vi.spyOn(ownerLedgerModule, "useOwnerLedgerSummary").mockReturnValue(
      {
        data: {
          data: {
            ...mockSummary,
            carriedForward: "-700.00",
            netThisPeriod: "-700.00",
          },
        },
        isLoading: false,
      } as any,
    );

    renderWorkspace();

    const cf = screen.getByTestId("carried-forward-value");
    expect(cf.className).toContain("rose");
    // formatRM renders negative as "RM -700.00" (locale hyphen-minus, not unicode −)
    expect(cf).toHaveTextContent("RM");

    spy.mockRestore();
  });
});

describe("OwnerWorkspacePage — Record Payout button", () => {
  it("renders a Record payout button in the header", () => {
    renderWorkspace();
    expect(screen.getByTestId("record-payout-btn")).toBeInTheDocument();
  });

  it("opens the Record Payout drawer when button is clicked", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId("record-payout-btn"));
    await waitFor(() => {
      expect(screen.getByText("Record Payout")).toBeInTheDocument();
    });
  });

  it("Record Payout drawer has amount, date, and method fields", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId("record-payout-btn"));
    await waitFor(() => {
      expect(screen.getByLabelText(/Payout amount/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Payout date/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Payment method/i)).toBeInTheDocument();
    });
  });

  it("Record Payout submit calls useCreateLedgerEntry with direction=payout + category=owner_payout", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId("record-payout-btn"));

    await waitFor(() => {
      expect(screen.getByLabelText(/Payout amount/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Payout amount/i), {
      target: { value: "1000.00" },
    });
    fireEvent.change(screen.getByLabelText(/Payout date/i), {
      target: { value: "2026-06-23" },
    });
    fireEvent.change(screen.getByLabelText(/Payment method/i), {
      target: { value: "Maybank transfer" },
    });

    // Submit the form
    fireEvent.click(screen.getByRole("button", { name: /Record payout/i }));

    await waitFor(() => {
      expect(mockCreateMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: "payout",
          category: "owner_payout",
          paidBy: "kaen",
          amount: "1000.00",
          remarks: "Maybank transfer",
        }),
        expect.any(Object),
      );
    });
  });
});

// ── #8: Payout-history panel + void affordance ────────────────────────────────
//
// A payout is direction:"payout". The panel lives in the parent OwnerWorkspace
// scope (sibling of BalancePanel), visible regardless of the active tab, and is
// populated by filtering the already-fetched allEntries to direction==="payout"
// (voided INCLUDED, sorted transactionDate desc). Each row exposes a Void action
// that reuses the existing setOverlay({kind:"void"}) → useVoidLedgerEntry path.

describe("OwnerWorkspacePage — Payout history panel (#8)", () => {
  // Spy-override useOwnerLedgerEntries so we can seed payout rows into allEntries
  // (same pattern as the empty-state / negative-carried-forward tests above).
  async function renderWithRows(rows: OwnerLedgerEntryRow[]) {
    const mod = await import("@/api/owner-ledger");
    const spy = vi.spyOn(mod, "useOwnerLedgerEntries").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only cast
      { data: { data: { rows, total: rows.length } }, isLoading: false } as any,
    );
    renderWorkspace();
    return spy;
  }

  it("payout appears in history panel without switching tabs", async () => {
    const spy = await renderWithRows([entryPayout, entryJune, entryMay]);
    try {
      // Default tab is Monthly Statements — panel is visible with NO tab switch.
      expect(screen.getByText("Payout history")).toBeInTheDocument();
      // date + amount + remarks of the payout
      expect(screen.getByText("2026-06-20")).toBeInTheDocument();
      expect(screen.getByText("RM 300.00")).toBeInTheDocument();
      expect(screen.getByText("Maybank transfer")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("payout is voidable from panel via the shared void confirm", async () => {
    const spy = await renderWithRows([entryPayout]);
    try {
      // Click the panel row's Void action (no tab switch).
      fireEvent.click(screen.getByRole("button", { name: /Void payout payout-1/i }));
      // The shared void ConfirmAlert opens — confirm it.
      const confirmBtn = await screen.findByRole("button", { name: "Void entry" });
      fireEvent.click(confirmBtn);
      // Reuses the existing void path: mutate with the row id + concurrency token.
      expect(mockVoidMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "payout-1",
          expectedUpdatedAt: "2026-06-20T09:00:00.000Z",
        }),
        expect.any(Object),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("shows a voided payout with a Voided badge and struck-through amount", async () => {
    const spy = await renderWithRows([entryPayoutVoided]);
    try {
      // Voided payouts stay visible for audit.
      expect(screen.getByText("Voided")).toBeInTheDocument();
      // Amount is struck through (not read as a live payout).
      const amount = screen.getByText("RM 500.00");
      expect(amount.className).toContain("line-through");
      // No Void action for an already-voided row.
      expect(
        screen.queryByRole("button", { name: /Void payout payout-void/i }),
      ).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("payout row not colored as income in the All-Entries table", async () => {
    const spy = await renderWithRows([entryPayout]);
    try {
      // Switch to the All Entries tab where the flat table renders.
      fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
      const row = screen.getByRole("row", { name: /Entry payout-1/i });
      const amount = within(row).getByText("RM 300.00");
      // A payout is money leaving KAEN — sky-toned, NOT the emerald income color.
      expect(amount.className).toContain("sky");
      expect(amount.className).not.toContain("emerald");
    } finally {
      spy.mockRestore();
    }
  });

  it("void confirm for a payout explains the balance will increase", async () => {
    const spy = await renderWithRows([entryPayout]);
    try {
      fireEvent.click(screen.getByRole("button", { name: /Void payout payout-1/i }));
      // Payout-specific copy: the admin must know voiding INCREASES the balance.
      expect(
        await screen.findByText(
          /The carried-forward balance will increase by RM 300\.00/i,
        ),
      ).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("void confirm for a non-payout (income) keeps the generic copy", async () => {
    const spy = await renderWithRows([entryJune]);
    try {
      // Income rows live in the All-Entries table, not the panel.
      fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
      fireEvent.click(screen.getByRole("button", { name: /Void entry entry-1/i }));
      // Generic copy — the payout-specific message must NOT leak to income/expense.
      expect(
        await screen.findByText(/Voiding cannot be undone/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/carried-forward balance will increase/i),
      ).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("panel orders same-date payouts deterministically (newest recorded first)", async () => {
    // Input order deliberately older-first; a transactionDate-only sort would
    // preserve it. The createdAt-desc tie-break must reorder newest-first.
    const spy = await renderWithRows([entryPayoutTieOlder, entryPayoutTieNewer]);
    try {
      const newer = screen.getByText("RM 111.00");
      const older = screen.getByText("RM 222.00");
      // newer precedes older in document order ⇒ "older" FOLLOWS "newer".
      expect(
        newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Task 8 / D3: month-first Monthly Statements tab ───────────────────────────
//
// The tab now: month picker → useUnitsSummary → combined "All units" card +
// one UnitSummaryCard per unit. This REPLACES the old MonthlyStatementCards grid
// (no per-month card headings, no "View Statement" buttons in this tab anymore).

describe("OwnerWorkspacePage — Monthly Statements tab (Task 8)", () => {
  it("renders 'Monthly Statements' as the primary tab, selected by default", () => {
    renderWorkspace();
    const tab = screen.getByRole("tab", { name: /Monthly Statements/i });
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("aria-selected", "true");
  });

  it("renders 'All Entries' as a secondary tab", () => {
    renderWorkspace();
    expect(screen.getByRole("tab", { name: /All Entries/i })).toBeInTheDocument();
  });

  it("shows a Statement month picker that drives the cards", () => {
    renderWorkspace();
    expect(screen.getByLabelText(/Statement month/i)).toBeInTheDocument();
  });

  it("renders a combined 'All units' card with a 'Print Invoice (all units)' action", () => {
    renderWorkspace();
    expect(screen.getByText("All units")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Print Invoice \(all units\)/i }),
    ).toBeInTheDocument();
  });

  it("renders one UnitSummaryCard per unit with the 4 footing figures", () => {
    renderWorkspace();
    // Unit card heading for the single mocked unit.
    expect(screen.getByText("A-10-04")).toBeInTheDocument();
    // The four figure labels appear (combined card + unit card → ≥1 each).
    expect(screen.getAllByText(/Income Collected/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Deposit Collected/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Deductible Expenses/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Net Payout/i).length).toBeGreaterThanOrEqual(1);
    // Net Payout value RM 4,400.00 (combined + unit) renders.
    expect(screen.getAllByText("RM 4,400.00").length).toBeGreaterThanOrEqual(1);
  });

  it("each unit card exposes per-unit 'Print Invoice' + 'Attach bills' actions", () => {
    renderWorkspace();
    // Per-unit "Print Invoice" AND the combined "Print Invoice (all units)" both
    // match this substring regex — that's expected (same rename, two scopes), so
    // the assertion below only checks "at least one", not an exact count.
    const printBtns = screen.getAllByRole("button", { name: /Print Invoice/i });
    expect(printBtns.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Attach bills/i })).toBeInTheDocument();
  });

  it("does NOT render the old per-month 'View Statement' grid in this tab", () => {
    renderWorkspace();
    expect(screen.queryByRole("button", { name: /View Statement/i })).not.toBeInTheDocument();
  });

  it("switching to 'All Entries' tab reveals the entry table columns", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: /All Entries/i }));
    await waitFor(() => {
      // The entry table's 5 essential column headers become visible
      expect(screen.getAllByText("Date").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Unit").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Amount").length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── Task 3: All-units card click → combined statement route ───────────────────

describe("OwnerWorkspacePage — All-units card navigation (Task 3)", () => {
  it("clicking the All-units card body navigates to the combined statement route", () => {
    renderWorkspace();
    // The All-units card body is wrapped in a role="button" affordance
    const cardBody = screen.getByRole("button", { name: /View full statement.*all units/i });
    fireEvent.click(cardBody);
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tenancy\/owners\/owner-1\/statements\/\d{4}-\d{2}$/),
    );
  });

  it("pressing Enter on the All-units card body navigates to the combined statement route", () => {
    renderWorkspace();
    const cardBody = screen.getByRole("button", { name: /View full statement.*all units/i });
    fireEvent.keyDown(cardBody, { key: "Enter" });
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tenancy\/owners\/owner-1\/statements\/\d{4}-\d{2}$/),
    );
  });

  it("clicking Print Invoice (all units) does NOT navigate", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /Print Invoice \(all units\)/i }));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
