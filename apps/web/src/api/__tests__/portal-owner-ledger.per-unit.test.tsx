// portal-owner-ledger.per-unit.test.tsx — TDD test for Task 11: per-unit grouping
//
// Verifies that PortalOwnerLedgerPage groups transaction rows by unitCode and
// renders a per-unit section header + subtotal for each distinct code.
// Rows with null unitCode fall into a "Property-level" catch-all group.
//
// Group headers carry data-testid="unit-group-header" so assertions can
// distinguish them from per-row unitCode badges.
//
// Pattern mirrors apps/web/src/pages/portal/__tests__/owner-ledger.test.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PortalOwnerLedgerPage from "@/pages/portal/owner-ledger";

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

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SUMMARY = {
  grossRental: "4000.00",
  totalExpenses: "400.00",
  netRentalAfterExpenses: "3600.00",
  netPayoutToOwner: "3600.00",
  payoutsTotal: "0.00",
  byCategory: { management_fee: "400.00" },
  broughtForward: "0.00",
  carriedForward: "3600.00",
};

/** Income row for unit A-10-04 (whole-unit, owner-bearing). */
const ROW_APT1_INCOME = {
  id: "row-apt1-income",
  statementMonth: "2026-06",
  transactionDate: "2026-06-01",
  direction: "income",
  category: "rental",
  description: "Rent — A-10-04",
  remarks: null,
  amount: "2000.00",
  sstAmount: null,
  paidBy: "tenant",
  paymentStatus: "paid",
  taxCategory: "gross",
  attachmentKeys: [],
  propertyId: "prop-1",
  apartmentId: "apt-1",
  unitCode: "A-10-04",
  listingId: "lst-1",
};

/** Income row for unit A-19-02 (partitioned). */
const ROW_APT2_INCOME = {
  id: "row-apt2-income",
  statementMonth: "2026-06",
  transactionDate: "2026-06-01",
  direction: "income",
  category: "rental",
  description: "Rent — A-19-02",
  remarks: null,
  amount: "2000.00",
  sstAmount: null,
  paidBy: "tenant",
  paymentStatus: "paid",
  taxCategory: "gross",
  attachmentKeys: [],
  propertyId: "prop-1",
  apartmentId: "apt-2",
  unitCode: "A-19-02",
  listingId: "lst-2",
};

/** Management fee row with no unitCode (property-level charge). */
const ROW_PROPERTY_LEVEL = {
  id: "row-property-mgmt",
  statementMonth: "2026-06",
  transactionDate: "2026-06-15",
  direction: "expense",
  category: "management_fee",
  description: "Management fee — June",
  remarks: null,
  amount: "400.00",
  sstAmount: "32.00",
  paidBy: "kaen",
  paymentStatus: "paid",
  taxCategory: "management_fee",
  attachmentKeys: [],
  propertyId: "prop-1",
  apartmentId: null,
  unitCode: null,
  listingId: null,
};

function makeResponse(rows: unknown[]) {
  return { data: { rows, summary: SUMMARY } };
}

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

describe("PortalOwnerLedgerPage — per-unit grouping", () => {
  beforeEach(() => {
    portalApiFetch.mockReset();
  });

  it("renders a per-unit section header for each distinct unitCode", async () => {
    portalApiFetch.mockResolvedValue(
      makeResponse([ROW_APT1_INCOME, ROW_APT2_INCOME, ROW_PROPERTY_LEVEL]),
    );
    render(wrap(<PortalOwnerLedgerPage />));

    // Wait for data to load (summary cards appear first).
    await screen.findByText("Gross Rental");

    // Group headers carry data-testid="unit-group-header" and show unit codes.
    const headers = screen.getAllByTestId("unit-group-header");
    const texts = headers.map((h) => h.textContent ?? "");

    expect(texts.some((t) => t.includes("A-10-04"))).toBe(true);
    expect(texts.some((t) => t.includes("A-19-02"))).toBe(true);
    // Property-level group for null-unitCode rows.
    expect(texts.some((t) => t.includes("Property-level"))).toBe(true);
  });

  it("keeps all row descriptions visible within their groups", async () => {
    portalApiFetch.mockResolvedValue(
      makeResponse([ROW_APT1_INCOME, ROW_APT2_INCOME, ROW_PROPERTY_LEVEL]),
    );
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    expect(screen.getByText("Rent — A-10-04")).toBeInTheDocument();
    expect(screen.getByText("Rent — A-19-02")).toBeInTheDocument();
    expect(screen.getByText("Management fee — June")).toBeInTheDocument();
  });

  it("renders per-unit income subtotals for each group", async () => {
    portalApiFetch.mockResolvedValue(
      makeResponse([ROW_APT1_INCOME, ROW_APT2_INCOME, ROW_PROPERTY_LEVEL]),
    );
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    // Prove the GROUPED subtotal renders (not a coincidental GlowCard value):
    // scope each assertion to that unit's subtotal ROW via within(...).
    const subtotalRowApt1 = screen.getByText("Subtotal — A-10-04").closest("tr");
    expect(subtotalRowApt1).not.toBeNull();
    expect(within(subtotalRowApt1!).getByText("RM 2,000.00")).toBeInTheDocument();

    const subtotalRowApt2 = screen.getByText("Subtotal — A-19-02").closest("tr");
    expect(subtotalRowApt2).not.toBeNull();
    expect(within(subtotalRowApt2!).getByText("RM 2,000.00")).toBeInTheDocument();
  });

  it("renders a flat table with NO group headers when all rows share the same unitCode", async () => {
    // All rows from the same apartment — single-unit owner experience ≈ today.
    portalApiFetch.mockResolvedValue(
      makeResponse([
        ROW_APT1_INCOME,
        { ...ROW_APT1_INCOME, id: "row-apt1-b", description: "Extra income" },
      ]),
    );
    render(wrap(<PortalOwnerLedgerPage />));

    await screen.findByText("Gross Rental");

    // No group headers should appear when there is only one distinct unitCode.
    expect(screen.queryAllByTestId("unit-group-header")).toHaveLength(0);

    // But row descriptions are still visible.
    expect(screen.getByText("Rent — A-10-04")).toBeInTheDocument();
    expect(screen.getByText("Extra income")).toBeInTheDocument();
  });

  it("preserves owner-level summary GlowCards even in grouped view", async () => {
    portalApiFetch.mockResolvedValue(
      makeResponse([ROW_APT1_INCOME, ROW_APT2_INCOME]),
    );
    render(wrap(<PortalOwnerLedgerPage />));

    // Owner-level summary GlowCards stay unchanged.
    expect(await screen.findByText("Gross Rental")).toBeInTheDocument();
    expect(screen.getByText("RM 4,000.00")).toBeInTheDocument();
  });
});
