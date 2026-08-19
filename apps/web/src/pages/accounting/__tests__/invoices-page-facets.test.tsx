// Invoice-adjustments Phase 1.6 — the register's doc-type facet strip. Flag OFF
// (default, no env stub) must reproduce the pre-cut hardcoded query exactly (no
// tablist rendered). This file mounts the FULL page (mirroring
// receipt-actions.test.tsx's approach) because the facet strip lives inside
// AccountingInvoicesPage itself, not an extractable leaf component — so every
// hook the page's always-mounted child drawers (NewInvoiceDrawer,
// DocumentDetailDrawer) call must be safely stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const useBillingDocumentsMock = vi.fn((_filters?: unknown) => ({
  data: { data: { items: [], total: 100 } },
  isLoading: false,
}));

vi.mock("../../../api/billing-documents", () => ({
  useBillingDocuments: (filters: unknown) => useBillingDocumentsMock(filters),
  usePropertyOptions: () => ({ data: [], isLoading: false }),
  useBillingDocument: () => ({ data: undefined, isLoading: false }),
  fetchBillingDocumentPdfUrl: vi.fn(),
  useCreateChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
  useVoidChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../../api/accounting", () => ({
  useCreateManualInvoice: () => ({ mutate: vi.fn(), isPending: false }),
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

function lastQuery(): Record<string, unknown> | undefined {
  const calls = useBillingDocumentsMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

describe("Invoices register — doc-type facets (Phase 1.6)", () => {
  beforeEach(() => useBillingDocumentsMock.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  // OEA (R5): an owner-borne expense deducted from rent must be visible where an admin
  // looks for "what did we bill this month" — the DEFAULT facet — not behind a secondary
  // tab. It is a primary document (no originalDocumentId), so primaryOnly does not
  // exclude it.
  it("requests owner expense advices on the default Invoices facet", async () => {
    await mount();
    expect(lastQuery()?.docTypes).toContain("owner_expense_advice");
  });

  it("requests owner expense advices on the All documents facet too", async () => {
    vi.stubEnv("VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS", "true");
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "All documents" }));
    expect(lastQuery()?.docTypes).toContain("owner_expense_advice");
  });

  it("flag OFF: no facet tablist; query matches the pre-cut hardcoded Invoices shape", async () => {
    await mount();
    expect(screen.queryByRole("tablist", { name: "Document type" })).toBeNull();
    expect(lastQuery()).toMatchObject({
      docTypes: ["invoice", "debit_note", "owner_expense_advice"],
      primaryOnly: true,
      activeOnly: true,
    });
  });

  describe("flag ON (VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS)", () => {
    beforeEach(() => vi.stubEnv("VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS", "true"));

    it("renders All documents | Invoices | Proforma | Credit notes | Debit notes, Invoices selected by default", async () => {
      await mount();
      const tablist = screen.getByRole("tablist", { name: "Document type" });
      const tabs = within(tablist).getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual([
        "All documents",
        "Invoices",
        // Its own facet: a proforma is a REQUEST for payment the workflow replaces at
        // will, so it must not sit in the register an admin reads as "what did we bill".
        "Proforma",
        "Credit notes",
        "Debit notes",
      ]);
      expect(within(tablist).getByRole("tab", { name: "Invoices" })).toHaveAttribute("aria-selected", "true");
      // Default facet keeps its primaryOnly/activeOnly shape; docTypes now also carries
      // owner_expense_advice so an owner-borne expense is visible on the default tab.
      expect(lastQuery()).toMatchObject({
        docTypes: ["invoice", "debit_note", "owner_expense_advice"],
        primaryOnly: true,
        activeOnly: true,
      });
    });

    it("Credit notes facet queries docType credit_note with no primaryOnly/docTypes", async () => {
      await mount();
      fireEvent.click(screen.getByRole("tab", { name: "Credit notes" }));
      const q = lastQuery();
      expect(q).toMatchObject({ docType: "credit_note" });
      expect(q?.primaryOnly).toBeUndefined();
      expect(q?.docTypes).toBeUndefined();
    });

    it("Debit notes facet queries docType debit_note with primaryOnly explicitly false", async () => {
      await mount();
      fireEvent.click(screen.getByRole("tab", { name: "Debit notes" }));
      expect(lastQuery()).toMatchObject({ docType: "debit_note", primaryOnly: false });
    });

    it("All documents facet queries the full docTypes set with no primaryOnly", async () => {
      await mount();
      fireEvent.click(screen.getByRole("tab", { name: "All documents" }));
      const q = lastQuery();
      expect(q).toMatchObject({ docTypes: ["invoice", "credit_note", "debit_note", "refund_note", "owner_expense_advice", "proforma"] });
      expect(q?.primaryOnly).toBeUndefined();
    });

    it("switching a facet resets to page 1", async () => {
      await mount();
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      fireEvent.click(screen.getByRole("tab", { name: "Credit notes" }));
      expect(lastQuery()).toMatchObject({ page: 1 });
    });
  });
});
