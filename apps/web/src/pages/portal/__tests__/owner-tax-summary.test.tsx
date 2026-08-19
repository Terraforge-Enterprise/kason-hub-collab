import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalOwnerTaxSummaryPage from "../owner-tax-summary";

// ─── Mock portal API fetch ─────────────────────────────────────────────────────

const portalApiFetch = vi.fn();
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: (...args: unknown[]) => portalApiFetch(...args),
}));

// ─── Mock ExcelJS to avoid browser env issues ─────────────────────────────────

vi.mock("exceljs", () => {
  const mockWorksheet = {
    columns: [],
    getRow: () => ({ font: {}, commit: vi.fn() }),
    addRow: vi.fn(() => ({ font: {}, commit: vi.fn() })),
  };
  const mockWorkbook = {
    addWorksheet: () => mockWorksheet,
    xlsx: { writeBuffer: async () => new ArrayBuffer(0) },
  };
  return { default: { Workbook: vi.fn(() => mockWorkbook) } };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DISCLAIMER_TEXT =
  "This summary is prepared based on rental income and expenses recorded in the system. Please consult your tax agent for final tax filing and tax deductibility.";

// Ledger rows: mix of kaen-paid and owner-paid expenses
const LEDGER_FIXTURE = {
  data: {
    rows: [
      {
        id: "row-1",
        statementMonth: "2026-01",
        transactionDate: "2026-01-01",
        direction: "income",
        category: "rental_income",
        description: "Rent collected",
        remarks: null,
        amount: "2000.00",
        sstAmount: null,
        paidBy: "tenant",
        paymentStatus: "paid",
        taxCategory: "gross_income",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: "A1",
        listingId: null,
      },
      {
        id: "row-2",
        statementMonth: "2026-01",
        transactionDate: "2026-01-05",
        direction: "expense",
        category: "management_fee",
        description: "KAEN management fee",
        remarks: null,
        amount: "200.00",
        sstAmount: null,
        paidBy: "kaen",
        paymentStatus: "paid",
        taxCategory: "management_fee",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: "A1",
        listingId: null,
      },
      {
        id: "row-3",
        statementMonth: "2026-01",
        transactionDate: "2026-01-10",
        direction: "expense",
        category: "wifi",
        description: "WiFi subscription",
        remarks: null,
        amount: "80.00",
        sstAmount: null,
        paidBy: "owner",
        paymentStatus: "paid",
        taxCategory: "rental_expense",
        attachmentKeys: [],
        propertyId: "prop-1",
        apartmentId: null,
        unitCode: "A1",
        listingId: null,
      },
    ],
    summary: {
      grossRental: "2000.00",
      totalExpenses: "280.00",
      netRentalAfterExpenses: "1720.00",
      netPayoutToOwner: "1800.00",
      byCategory: {
        management_fee: "200.00",
        wifi: "80.00",
      },
    },
  },
};

const TAX_SUMMARY_FIXTURE = {
  data: {
    byTaxCategory: {
      management_fee: "200.00",
      rental_expense: "80.00",
    },
    byCategory: {
      management_fee: "200.00",
      wifi: "80.00",
    },
    totalExpenses: "280.00",
    disclaimer: DISCLAIMER_TEXT,
  },
};

// ─── Test wrapper ─────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PortalOwnerTaxSummaryPage (Income & Tax)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both hooks call portalApiFetch; match by the URL fragment they call.
    portalApiFetch.mockImplementation((url: string) => {
      if (url.includes("tax-summary")) return Promise.resolve(TAX_SUMMARY_FIXTURE);
      return Promise.resolve(LEDGER_FIXTURE);
    });
  });

  it("renders the 'Income & Tax' page heading", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    expect(await screen.findByText("Income & Tax")).toBeInTheDocument();
  });

  it("renders the disclaimer verbatim in a prominent callout", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    const disclaimer = await screen.findByText(DISCLAIMER_TEXT);
    expect(disclaimer).toBeInTheDocument();
  });

  it("renders the Gross Rental KPI card", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);
    expect(screen.getByText("Gross Rental")).toBeInTheDocument();
    // RM 2000.00 appears in the Gross Rental card
    expect(screen.getAllByText("RM 2,000.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the 'Expenses by Category' table", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);
    expect(screen.getByText("Expenses by Category")).toBeInTheDocument();
  });

  it("shows 'Paid by you' badge for the owner-paid wifi category", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    // "Wifi" category row should exist and show "Paid by you"
    expect(screen.getByText("Wifi")).toBeInTheDocument();
    // PaidByBadge maps paidBy="owner" → "Paid by you"
    expect(screen.getByText("Paid by you")).toBeInTheDocument();
  });

  it("does NOT show 'Paid by you' badge for the KAEN-paid management_fee category", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    // There should be exactly one "Paid by you" badge — only the wifi row
    const ownerBadges = screen.getAllByText("Paid by you");
    expect(ownerBadges).toHaveLength(1);
  });

  it("renders both Net Rental After Expenses AND Net Payout to Owner", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    // Both net figure labels must appear
    expect(screen.getByText("Net Rental After Expenses")).toBeInTheDocument();
    expect(screen.getByText("Net Payout to Owner")).toBeInTheDocument();

    // Both amounts must appear
    expect(screen.getAllByText("RM 1,720.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("RM 1,800.00").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the one-line note explaining the difference between the two nets", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    expect(
      screen.getByText(/owner-paid expenses.*included in the tax record but not deducted/i),
    ).toBeInTheDocument();
  });

  it("shows the Export Excel button when data is loaded", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);
    expect(screen.getByRole("button", { name: /export excel/i })).toBeInTheDocument();
  });

  it("does not show Export Excel while loading", () => {
    // never resolve — keeps query in loading state
    portalApiFetch.mockReturnValue(new Promise(() => {}));
    render(wrap(<PortalOwnerTaxSummaryPage />));
    expect(screen.queryByRole("button", { name: /export excel/i })).not.toBeInTheDocument();
  });

  it("does NOT render the word 'deductible' as a standalone item label in table cells", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    // The spec hard rule: "deductible" must not appear as a cell label.
    // It may appear inside the disclaimer string — we target table cells only.
    const allCells = document.querySelectorAll("td");
    const deductibleLabels = Array.from(allCells).filter(
      (el) =>
        el.textContent?.toLowerCase() === "deductible" ||
        el.textContent?.toLowerCase() === "tax deductible",
    );
    expect(deductibleLabels).toHaveLength(0);
  });

  it("renders tax category badges for expense rows", async () => {
    render(wrap(<PortalOwnerTaxSummaryPage />));
    await screen.findByText(DISCLAIMER_TEXT);

    // "Management Fee" tax class should appear as a badge
    expect(screen.getAllByText("Management Fee").length).toBeGreaterThanOrEqual(1);
    // "Rental Expense" tax class badge
    expect(screen.getByText("Rental Expense")).toBeInTheDocument();
  });
});
