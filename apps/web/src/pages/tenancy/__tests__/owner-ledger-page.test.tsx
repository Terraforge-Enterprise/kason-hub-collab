import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
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

import { apiFetch } from "@/lib/api-client";
import type { OwnerLedgerEntryRow } from "@/api/owner-ledger";
import OwnerLedgerPage from "../owner-ledger-page";

const apiFetchMock = vi.mocked(apiFetch);

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(over: Partial<OwnerLedgerEntryRow>): OwnerLedgerEntryRow {
  return {
    id: "entry-1",
    organizationId: "org-1",
    ownerPartyId: "owner-1",
    propertyId: "prop-1",
    apartmentId: null,
    unitCode: null,
    listingId: null,
    tenancyId: null,
    statementMonth: "2026-06",
    transactionDate: "2026-06-01",
    direction: "income",
    category: "rental_income",
    description: "June rent",
    remarks: null,
    amount: "2000.00",
    chargedAmount: null,
    debitAdjustmentAmount: "0.00",
    creditAdjustmentAmount: "0.00",
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "not_applicable",
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
    ...over,
  };
}

const owners = [
  { id: "owner-1", displayName: "Tan Sri Lim" },
  { id: "owner-2", displayName: "Datuk Wong" },
];

const properties = [
  { id: "prop-1", name: "Areca Residences" },
];

const entry1 = makeEntry({ id: "entry-1", ownerPartyId: "owner-1", amount: "2000.00" });
const entry2 = makeEntry({
  id: "entry-2",
  ownerPartyId: "owner-2",
  direction: "expense",
  category: "management_fee",
  amount: "200.00",
  sstAmount: "12.00",
  paidBy: "owner",
  paymentStatus: "pending",
});

// Owners summary fixture (unitCodes now required by smart search)
const ownerSummaryRows = [
  {
    ownerPartyId: "owner-1",
    ownerName: "Tan Sri Lim",
    unitCount: 3,
    unitCodes: ["A-01-01", "A-01-02", "A-01-03"],
    grossRental: "6000.00",
    totalExpenses: "600.00",
    netPayoutToOwner: "5400.00",
    pendingCount: 0,
    lastEntryMonth: "2026-06",
  },
  {
    ownerPartyId: "owner-2",
    ownerName: "Datuk Wong",
    unitCount: 1,
    unitCodes: ["B-15-03"],
    grossRental: "1200.00",
    totalExpenses: "120.00",
    netPayoutToOwner: "1080.00",
    pendingCount: 2,
    lastEntryMonth: "2026-06",
  },
];

function stubApi(rows: OwnerLedgerEntryRow[] = [entry1, entry2]) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/parties/owners") {
      return Promise.resolve({ data: owners }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/inventory/properties") {
      return Promise.resolve({ data: properties }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners-summary")) {
      return Promise.resolve({ data: { owners: ownerSummaryRows } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/entries")) {
      return Promise.resolve({ data: { rows, total: rows.length } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/units-summary")) {
      return Promise.resolve({ data: { items: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

function stubApiEmpty() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/parties/owners") {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/inventory/properties") {
      return Promise.resolve({ data: [] }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners-summary")) {
      return Promise.resolve({ data: { owners: [] } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/units-summary")) {
      return Promise.resolve({ data: { items: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenancy/owner-ledger"]}>
        <OwnerLedgerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Owners is now the default (owner-first front door). This helper keeps the
 * explicit Owners-tab click so tests read intent-first and stay robust if the
 * default ever changes again; clicking the already-active tab is a no-op.
 */
function renderOwnersTab() {
  const utils = renderPage();
  fireEvent.click(screen.getByRole("radio", { name: /^Owners$/ }));
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OwnerLedgerPage — header", () => {
  it("renders the page heading", () => {
    stubApiEmpty();
    renderOwnersTab();
    expect(screen.getByRole("heading", { name: /Owner Ledger/i })).toBeInTheDocument();
  });

  it("renders the New entry and Month review action buttons", () => {
    stubApiEmpty();
    renderOwnersTab();
    expect(screen.getByRole("button", { name: /New entry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Month review/i })).toBeInTheDocument();
  });
});

describe("OwnerLedgerPage — Owners tab", () => {
  it("renders the Owners tab as the default active tab (owner-first front door)", () => {
    stubApiEmpty();
    renderPage();
    const ownersRadio = screen.getByRole("radio", { name: /^Owners$/ });
    expect(ownersRadio).toHaveAttribute("aria-checked", "true");
  });

  it("switches to the Owners tab on click", () => {
    stubApiEmpty();
    renderOwnersTab();
    const ownersRadio = screen.getByRole("radio", { name: /^Owners$/ });
    expect(ownersRadio).toHaveAttribute("aria-checked", "true");
  });

  it("calls owners-summary with NO month params by default (all-time)", async () => {
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].startsWith("/owner-ledger/owners-summary") &&
          !c[0].includes("fromMonth") &&
          !c[0].includes("toMonth"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("renders aggregate rows from useOwnersSummary with owner names and MYR amounts", async () => {
    stubApi();
    renderOwnersTab();

    // Wait for the owners table to appear
    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });

    const tbl = screen.getByRole("table", { name: /Owner summary/i });

    await waitFor(() => {
      expect(within(tbl).getByText("Tan Sri Lim")).toBeInTheDocument();
      expect(within(tbl).getByText("Datuk Wong")).toBeInTheDocument();
    });

    // Gross / Net Payout formatted
    expect(within(tbl).getByText("RM 6,000.00")).toBeInTheDocument();
    expect(within(tbl).getByText("RM 5,400.00")).toBeInTheDocument();
    // Unit counts
    expect(within(tbl).getByText("3")).toBeInTheDocument();
  });

  it("narrows owner rows when searching by owner name", async () => {
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });

    const tbl = screen.getByRole("table", { name: /Owner summary/i });
    await waitFor(() => {
      expect(within(tbl).getByText("Tan Sri Lim")).toBeInTheDocument();
      expect(within(tbl).getByText("Datuk Wong")).toBeInTheDocument();
    });

    const searchBox = screen.getByRole("textbox", { name: /Search owners or units/i });
    fireEvent.change(searchBox, { target: { value: "Tan Sri" } });

    await waitFor(() => {
      expect(within(tbl).getByText("Tan Sri Lim")).toBeInTheDocument();
      expect(within(tbl).queryByText("Datuk Wong")).not.toBeInTheDocument();
    });
  });

  it("narrows owner rows when searching by unit code", async () => {
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });

    const tbl = screen.getByRole("table", { name: /Owner summary/i });
    await waitFor(() => {
      expect(within(tbl).getByText("Tan Sri Lim")).toBeInTheDocument();
      expect(within(tbl).getByText("Datuk Wong")).toBeInTheDocument();
    });

    // Search by Datuk Wong's unit code
    const searchBox = screen.getByRole("textbox", { name: /Search owners or units/i });
    fireEvent.change(searchBox, { target: { value: "B-15-03" } });

    await waitFor(() => {
      expect(within(tbl).queryByText("Tan Sri Lim")).not.toBeInTheDocument();
      expect(within(tbl).getByText("Datuk Wong")).toBeInTheDocument();
    });
  });

  it("calls navigate with the owner workspace route when a row is clicked", async () => {
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("row", { name: /Owner Tan Sri Lim/i })).toBeInTheDocument();
    });

    const row = screen.getByRole("row", { name: /Owner Tan Sri Lim/i });
    fireEvent.click(row);

    expect(mockNavigate).toHaveBeenCalledWith("/tenancy/owner-ledger/owner-1");
  });

  it("shows empty state message when there are no owners", async () => {
    stubApiEmpty();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/No owners found\./i)).toBeInTheDocument();
    });
  });

  it("shows pending count badge for owners with pending entries", async () => {
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });

    // ownerSummaryRows[1] (Datuk Wong) has pendingCount: 2 → amber badge IN the
    // table. Scope to the table: the redesigned summary GlowCard row also shows
    // aggregate "2"s (owner count + total pending), so an unscoped getByText
    // would be ambiguous.
    const tbl = screen.getByRole("table", { name: /Owner summary/i });
    await waitFor(() => {
      expect(within(tbl).getByText("2")).toBeInTheDocument();
    });
  });

  it("shows a summary row aggregating gross + net payout across visible owners", async () => {
    stubApi();
    renderOwnersTab();

    // Totals across the two fixture owners:
    //   gross 6000 + 1200 = 7200 · net 5400 + 1080 = 6480.
    // These aggregate figures are unique to the summary row (never appear as a
    // single owner row), so an unscoped lookup is unambiguous.
    await waitFor(() => {
      expect(screen.getByText("RM 7,200.00")).toBeInTheDocument();
      expect(screen.getByText("RM 6,480.00")).toBeInTheDocument();
    });
  });

  it("Date range toggle is not expanded by default (all-time view)", () => {
    stubApiEmpty();
    renderOwnersTab();
    // The date pickers should NOT be visible initially (aria-label lookup, type=month)
    expect(screen.queryByLabelText(/From month/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/To month/i)).not.toBeInTheDocument();
  });

  it("opens date range pickers on toggle click and applies months to hook", async () => {
    stubApi();
    renderOwnersTab();

    // Click the date range toggle
    const toggleBtn = screen.getByRole("button", { name: /Date range/i });
    fireEvent.click(toggleBtn);

    // Pickers should appear (type=month — use getByLabelText not getByRole textbox)
    await waitFor(() => {
      expect(screen.getByLabelText(/From month/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/To month/i)).toBeInTheDocument();
    });

    // Set both months
    fireEvent.change(screen.getByLabelText(/From month/i), {
      target: { value: "2026-06" },
    });
    fireEvent.change(screen.getByLabelText(/To month/i), {
      target: { value: "2026-06" },
    });

    // Dismissible chip should appear
    await waitFor(() => {
      expect(screen.getByText("2026-06 – 2026-06")).toBeInTheDocument();
    });

    // Hook should now be called with month params
    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].startsWith("/owner-ledger/owners-summary") &&
          c[0].includes("fromMonth=2026-06") &&
          c[0].includes("toMonth=2026-06"),
      );
      expect(call).toBeTruthy();
    });
  });

  it("clears date range and returns to all-time when chip × is clicked", async () => {
    stubApi();
    renderOwnersTab();

    // Open toggle and set months
    fireEvent.click(screen.getByRole("button", { name: /Date range/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/From month/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/From month/i), {
      target: { value: "2026-05" },
    });
    fireEvent.change(screen.getByLabelText(/To month/i), {
      target: { value: "2026-06" },
    });

    // Chip appears
    await waitFor(() => {
      expect(screen.getByLabelText(/Clear date range/i)).toBeInTheDocument();
    });

    // Dismiss the chip
    fireEvent.click(screen.getByLabelText(/Clear date range/i));

    // Chip should be gone, pickers collapsed
    await waitFor(() => {
      expect(screen.queryByLabelText(/From month/i)).not.toBeInTheDocument();
    });
  });
});

// ─── Unit sub-row fixtures ────────────────────────────────────────────────────

const ownerWithUnits = {
  ownerPartyId: "owner-1",
  ownerName: "Tan Sri Lim",
  unitCount: 2,
  unitCodes: ["A-01-01", "A-01-02"],
  grossRental: "6000.00",
  totalExpenses: "600.00",
  netPayoutToOwner: "5400.00",
  pendingCount: 0,
  lastEntryMonth: "2026-06",
  units: [
    {
      apartmentId: "apt-1",
      unitCode: "A-01-01",
      grossRental: "3000.00",
      totalExpenses: "300.00",
      netPayoutToOwner: "2700.00",
    },
    {
      apartmentId: "apt-2",
      unitCode: "A-01-02",
      grossRental: "3000.00",
      totalExpenses: "300.00",
      netPayoutToOwner: "2700.00",
    },
  ],
};

function stubApiWithUnits() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/parties/owners") {
      return Promise.resolve({ data: owners }) as ReturnType<typeof apiFetch>;
    }
    if (path === "/inventory/properties") {
      return Promise.resolve({ data: properties }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/owners-summary")) {
      return Promise.resolve({ data: { owners: [ownerWithUnits] } }) as ReturnType<typeof apiFetch>;
    }
    if (path.startsWith("/owner-ledger/units-summary")) {
      return Promise.resolve({ data: { items: [], total: 0 } }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: { rows: [], total: 0 } }) as ReturnType<typeof apiFetch>;
  });
}

describe("OwnerLedgerPage — unit sub-rows", () => {
  it("renders an expand toggle for an owner that has units", async () => {
    stubApiWithUnits();
    renderOwnersTab();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Expand units for Tan Sri Lim/i),
      ).toBeInTheDocument();
    });
  });

  it("shows unit sub-rows for both units when the expand toggle is clicked", async () => {
    stubApiWithUnits();
    renderOwnersTab();

    // Wait for toggle to appear
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Expand units for Tan Sri Lim/i),
      ).toBeInTheDocument();
    });

    // Click the toggle
    fireEvent.click(screen.getByLabelText(/Expand units for Tan Sri Lim/i));

    // Both unit codes should render as sub-rows
    await waitFor(() => {
      expect(
        screen.getByRole("row", { name: /Unit A-01-01 under Tan Sri Lim/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("row", { name: /Unit A-01-02 under Tan Sri Lim/i }),
      ).toBeInTheDocument();
    });
  });

  it("collapses sub-rows when the toggle is clicked a second time", async () => {
    stubApiWithUnits();
    renderOwnersTab();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Expand units for Tan Sri Lim/i),
      ).toBeInTheDocument();
    });

    // Expand
    fireEvent.click(screen.getByLabelText(/Expand units for Tan Sri Lim/i));
    await waitFor(() => {
      expect(
        screen.getByRole("row", { name: /Unit A-01-01 under Tan Sri Lim/i }),
      ).toBeInTheDocument();
    });

    // Collapse (toggle shows "Collapse" label after expansion)
    fireEvent.click(screen.getByLabelText(/Collapse units for Tan Sri Lim/i));
    await waitFor(() => {
      expect(
        screen.queryByRole("row", { name: /Unit A-01-01 under Tan Sri Lim/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("navigates to the unit workspace when a unit sub-row is clicked (P4)", async () => {
    stubApiWithUnits();
    renderOwnersTab();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Expand units for Tan Sri Lim/i),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Expand units for Tan Sri Lim/i));

    await waitFor(() => {
      expect(
        screen.getByRole("row", { name: /Unit A-01-01 under Tan Sri Lim/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("row", { name: /Unit A-01-01 under Tan Sri Lim/i }),
    );

    expect(mockNavigate).toHaveBeenCalledWith(
      "/tenancy/owner-ledger/unit/apt-1",
    );
  });

  it("does NOT trigger owner-level navigation when the expand toggle is clicked", async () => {
    stubApiWithUnits();
    renderOwnersTab();

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Expand units for Tan Sri Lim/i),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Expand units for Tan Sri Lim/i));

    // navigate should NOT have been called (toggle stops propagation)
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does not render an expand toggle for owners without units", async () => {
    // ownerSummaryRows fixture has no units[]
    stubApi();
    renderOwnersTab();

    await waitFor(() => {
      expect(screen.getByRole("table", { name: /Owner summary/i })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Tan Sri Lim")).toBeInTheDocument();
    });

    // No expand toggles should be present
    expect(screen.queryByLabelText(/Expand units for/i)).not.toBeInTheDocument();
  });
});

describe("OwnerLedgerPage — All entries tab", () => {
  it("switches to All entries tab when clicked", async () => {
    stubApi();
    renderOwnersTab();

    const allEntriesRadio = screen.getByRole("radio", { name: /All entries/i });
    fireEvent.click(allEntriesRadio);

    await waitFor(() => {
      expect(allEntriesRadio).toHaveAttribute("aria-checked", "true");
    });
  });

  it("renders the flat entries table in All entries tab", async () => {
    stubApi();
    renderOwnersTab();

    // Switch to All entries
    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    // Wait for entries table to appear (EnhancedDataTable renders a role=table)
    await waitFor(() => {
      // The entries table should contain data once query settles
      expect(screen.getByRole("button", { name: /Filters/i })).toBeInTheDocument();
    });
  });

  it("renders PaidByBadge in the Paid By column", async () => {
    stubApi();
    renderOwnersTab();

    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    await waitFor(() => {
      // entry1 has paidBy: "kaen" — PaidByBadge renders "Paid by KAEN"
      expect(screen.getByText(/Paid by KAEN/i)).toBeInTheDocument();
    });
  });

  it("shows Filters disclosure panel when Filters button is clicked", async () => {
    stubApiEmpty();
    renderOwnersTab();

    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    const filtersBtn = screen.getByRole("button", { name: /Filters/i });
    expect(screen.queryByRole("combobox", { name: /Owner filter/i })).not.toBeInTheDocument();

    fireEvent.click(filtersBtn);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /Owner filter/i })).toBeInTheDocument();
    });
  });

  it("shows a dismissible chip when a filter is applied, and clears it on dismiss", async () => {
    stubApi();
    renderOwnersTab();

    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    // Open filters panel
    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));

    // Wait for the owner dropdown to render and for owners to be loaded
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /Owner filter/i })).toBeInTheDocument();
    });
    // Wait until owners are loaded (option "Tan Sri Lim" appears in the select)
    await waitFor(() => {
      const select = screen.getByRole("combobox", { name: /Owner filter/i });
      expect(within(select as HTMLElement).getByText("Tan Sri Lim")).toBeInTheDocument();
    });

    // Select owner-1 in the owner filter
    const ownerSelect = screen.getByRole("combobox", { name: /Owner filter/i });
    fireEvent.change(ownerSelect, { target: { value: "owner-1" } });

    // A chip should appear — aria-label contains "Clear filter: Owner"
    // (owner name may not yet be resolved, so match prefix only)
    await waitFor(() => {
      expect(screen.getByLabelText(/Clear filter: Owner/i)).toBeInTheDocument();
    });

    // Dismiss the chip
    const dismissBtn = screen.getByLabelText(/Clear filter: Owner/i);
    fireEvent.click(dismissBtn);

    // Chip should disappear
    await waitFor(() => {
      expect(screen.queryByLabelText(/Clear filter: Owner/i)).not.toBeInTheDocument();
    });
  });

  it("queries /owner-ledger/entries with limit + offset when on All entries tab", async () => {
    stubApi();
    renderOwnersTab();

    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    await waitFor(
      () => {
        const pagingCall = apiFetchMock.mock.calls.find(
          (c) =>
            typeof c[0] === "string" &&
            c[0].startsWith("/owner-ledger/entries") &&
            c[0].includes("limit=20") &&
            c[0].includes("offset=0"),
        );
        expect(pagingCall).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("renders Void action button but NO Edit button in All entries tab", async () => {
    stubApi();
    renderOwnersTab();

    fireEvent.click(screen.getByRole("radio", { name: /All entries/i }));

    await waitFor(() => {
      const voidBtns = screen.getAllByRole("button", { name: /Void entry/i });
      expect(voidBtns.length).toBeGreaterThan(0);
    });

    expect(screen.queryAllByRole("button", { name: /Edit entry/i }).length).toBe(0);
  });
});
