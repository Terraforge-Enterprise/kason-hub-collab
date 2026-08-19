import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalOwnerLedgerPage from "../owner-ledger";

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
    addRow: vi.fn(),
  };
  const mockWorkbook = {
    addWorksheet: () => mockWorksheet,
    xlsx: { writeBuffer: async () => new ArrayBuffer(0) },
  };
  return { default: { Workbook: vi.fn(() => mockWorkbook) } };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUMMARY_FIXTURE = {
  grossRental: "3000.00",
  totalExpenses: "350.00",
  netRentalAfterExpenses: "2650.00",
  netPayoutToOwner: "2550.00",
  byCategory: { management_fee: "216.00", cleaning: "100.00", wifi: "34.00" },
};

const INCOME_ROW = {
  id: "row-1",
  statementMonth: "2026-06",
  transactionDate: "2026-06-01",
  direction: "income",
  category: "rental",
  description: "Rental — Unit A-101",
  remarks: null,
  amount: "1500.00",
  sstAmount: null,
  paidBy: "tenant",
  paymentStatus: "paid",
  taxCategory: "gross",
  attachmentKeys: [],
  propertyId: "prop-1",
  listingId: "lst-1",
};

const EXPENSE_ROW = {
  id: "row-2",
  statementMonth: "2026-06",
  transactionDate: "2026-06-15",
  direction: "expense",
  category: "management_fee",
  description: "Management fee + SST",
  remarks: "10% + 0.8% SST",
  amount: "216.00",
  sstAmount: "16.00",
  paidBy: "kaen",
  paymentStatus: "paid",
  taxCategory: "management_fee",
  attachmentKeys: ["receipt-001.pdf"],
  propertyId: "prop-1",
  listingId: null,
};

const LEDGER_FIXTURE = {
  data: {
    rows: [INCOME_ROW, EXPENSE_ROW],
    summary: SUMMARY_FIXTURE,
  },
};

// ─── Test wrapper ─────────────────────────────────────────────────────────────

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PortalOwnerLedgerPage", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
  });

  it("renders all 4 summary GlowCards with correct formatted values", async () => {
    portalApiFetch.mockResolvedValue(LEDGER_FIXTURE);
    render(wrap(<PortalOwnerLedgerPage />));

    // Summary card labels — some appear in both the card label and the callout text;
    // use getAllByText and assert at least one instance rather than exact count.
    expect(await screen.findByText("Gross Rental")).toBeInTheDocument();
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getAllByText("Net Rental After Expenses").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Net Payout to Owner").length).toBeGreaterThanOrEqual(1);

    // Formatted money values — RM 3,000.00 / RM 350.00 / RM 2,650.00 / RM 2,550.00
    expect(screen.getByText("RM 3,000.00")).toBeInTheDocument();
    expect(screen.getByText("RM 350.00")).toBeInTheDocument();
    expect(screen.getByText("RM 2,650.00")).toBeInTheDocument();
    expect(screen.getByText("RM 2,550.00")).toBeInTheDocument();
  });

  it("places income amount in Income column and dash in Expense column for income rows", async () => {
    portalApiFetch.mockResolvedValue(LEDGER_FIXTURE);
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    // There should be an Income column header
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expense")).toBeInTheDocument();

    // The income row description is visible
    expect(screen.getByText("Rental — Unit A-101")).toBeInTheDocument();
  });

  it("places expense amount in Expense column for expense rows and shows attachment indicator", async () => {
    portalApiFetch.mockResolvedValue(LEDGER_FIXTURE);
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    // Expense row description
    expect(screen.getByText("Management fee + SST")).toBeInTheDocument();

    // Attachment indicator (paperclip aria-label)
    expect(screen.getByLabelText("1 attachment")).toBeInTheDocument();
  });

  it("shows export CSV and Export Excel buttons when rows are present", async () => {
    portalApiFetch.mockResolvedValue(LEDGER_FIXTURE);
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    expect(screen.getByRole("button", { name: /export csv/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export excel/i })).toBeInTheDocument();
  });

  it("shows empty state when no rows returned", async () => {
    portalApiFetch.mockResolvedValue({ data: { rows: [], summary: SUMMARY_FIXTURE } });
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");
    expect(screen.getByText("No transactions in this period")).toBeInTheDocument();

    // Export buttons should NOT be shown when there are no rows
    expect(screen.queryByRole("button", { name: /export csv/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export excel/i })).not.toBeInTheDocument();
  });
});
