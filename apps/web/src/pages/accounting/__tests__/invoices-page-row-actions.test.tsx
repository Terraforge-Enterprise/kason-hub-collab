// Invoice-adjustments rework (Change 1) — the drawer is the single container:
// the register row no longer duplicates "Record payment"/"Adjust" (they moved
// into the Payments/Adjustments tabs). "Correct" has since gone the same way —
// its CREDIT_ADJUSTMENT/DEBIT_ADJUSTMENT strategies ARE the Adjustments tab's
// inline add-row — so the register now has NO row actions and no Actions column
// at all, and the detail drawer's footer is just Download PDF + Close.
// Row click still opens the detail drawer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentListItem } from "@kason/shared";

const OUTSTANDING_TENANT_INVOICE: BillingDocumentListItem = {
  id: "d1",
  docType: "invoice",
  documentNumber: "IVTEN-0001",
  seriesCode: "IVTEN",
  status: "issued",
  documentStatus: "ISSUED",
  taxStatus: "none",
  settlementStatus: "UNPAID",
  counterpartyType: "tenant",
  partyId: "p1",
  partyName: "Tenant One",
  propertyName: "PV1",
  unitCode: "A-01-01",
  billingMonth: "2026-07-01",
  issuedAt: "2026-07-19T00:00:00.000Z",
  total: "250.00",
  originalDocumentNumber: null,
  paymentId: null,
} as unknown as BillingDocumentListItem;

const useBillingDocumentsMock = vi.fn((_filters?: unknown) => ({
  data: { data: { items: [OUTSTANDING_TENANT_INVOICE], total: 1 } },
  isLoading: false,
}));

vi.mock("../../../api/billing-documents", () => ({
  useBillingDocuments: (filters: unknown) => useBillingDocumentsMock(filters),
  usePropertyOptions: () => ({ data: [], isLoading: false }),
  useBillingDocument: (id: string | null) => ({
    data: id
      ? { data: { id, documentNumber: "IVTEN-0001", partyName: "Tenant One", amountPaid: "0.00", balance: "250.00", lines: [], relatedDocuments: [] } }
      : undefined,
    isLoading: false,
  }),
  fetchBillingDocumentPdfUrl: vi.fn(),
  useCreateChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
  useVoidChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../../api/accounting", () => ({
  useCreateManualInvoice: () => ({ mutate: vi.fn(), isPending: false }),
  useRecordInvoicePayment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  uploadSlipProof: vi.fn(),
  deleteSlipProof: vi.fn(),
}));

vi.mock("../../../api/charge-categories", () => ({
  useChargeCategories: () => ({ data: { items: [] }, isLoading: false }),
}));

vi.mock("../../../api/charges", () => ({
  usePartyOpenCharges: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/api/audit-log", () => ({
  useAuditTimeline: () => ({ rows: [], isLoading: false, isError: false, isForbidden: false }),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => ({ data: [] })),
  ApiError: class ApiError extends Error {},
}));

async function mount() {
  const { default: AccountingInvoicesPage } = await import("../invoices-page");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountingInvoicesPage />
    </QueryClientProvider>,
  );
}

describe("Invoices register row actions (invoice-adjustments rework, Change 1)", () => {
  beforeEach(() => {
    useBillingDocumentsMock.mockClear();
  });

  it("flag OFF: the row has NO actions — no Correct, Record payment or Adjust", async () => {
    await mount();
    const row = screen.getByText("IVTEN-0001").closest("tr")!;
    expect(within(row).queryByRole("button", { name: /^correct$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /record payment/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^adjust$/i })).toBeNull();
    // The document-number link is the row's ONLY button — proof the actions cell is gone.
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "View IVTEN-0001",
    ]);
    expect(screen.queryByRole("columnheader", { name: /^actions$/i })).toBeNull();
  });

  it("flag ON: the row STILL has no actions and no Actions column", async () => {
    vi.stubEnv("VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS", "true");
    await mount();
    const row = screen.getByText("IVTEN-0001").closest("tr")!;
    expect(within(row).queryByRole("button", { name: /^correct$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /record payment/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^adjust$/i })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^actions$/i })).toBeNull();
    vi.unstubAllEnvs();
  });

  it("the drawer footer offers neither Record payment NOR Correct", async () => {
    vi.stubEnv("VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS", "true");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /view ivten-0001/i }));
    // Drawer opened — the document header renders the number again inside the sheet.
    expect(await screen.findAllByText("IVTEN-0001")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /record payment/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^correct$/i })).toBeNull();
    // What DOES survive in the footer.
    expect(screen.getByRole("button", { name: /download pdf/i })).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it("clicking a row still opens the detail drawer", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /view ivten-0001/i }));
    expect(await screen.findByText("Billed to Tenant One")).toBeInTheDocument();
  });
});
