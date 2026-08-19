// Invoice-adjustments Phase 1/2 — the flag-gated tabbed detail-drawer layout.
// Flag OFF (default, no env stub) must render the pre-cut single-scroll layout
// unchanged — see document-detail-drawer.test.tsx / status-badges.test.tsx,
// which mount with NO env stub and must keep passing untouched. This file only
// covers the flag-ON tab behavior + the new server-derived line/adjustments UI.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentListItem } from "@kason/shared";

vi.mock("@/api/audit-log", () => ({
  useAuditTimeline: () => ({ rows: [], isLoading: false, isError: false, isForbidden: false }),
}));

const doc: BillingDocumentListItem = {
  id: "d1", docType: "invoice", documentNumber: "IVTEN-0009", seriesCode: "IVTEN",
  status: "partially_settled", documentStatus: "ISSUED", taxStatus: "none", settlementStatus: "PARTIALLY_PAID",
  derivedPaymentStatus: "PARTIALLY_PAID", adjustmentStatus: "CREDIT_NOTE_ISSUED", isReBilled: false,
  adjustedTotal: "227.00",
  issuedAt: "2026-07-19T00:00:00.000Z", billingMonth: "2026-07-01", counterpartyType: "tenant",
  partyId: "p1", partyName: "Tenant Nine", unitCode: "A-08-03", propertyName: "PV9",
  total: "250.00", originalDocumentNumber: null, paymentId: null,
} as unknown as BillingDocumentListItem;

const detail = {
  ...doc,
  subtotal: "250.00", sstAmount: "0.00", creditAmount: null,
  debitNoteTotal: "0.00", creditNoteTotal: "23.00",
  amountPaid: "150.00", balance: "77.00", reason: null, statementInvoiceId: null, hasPdf: false,
  lines: [
    {
      id: "l1", chargeId: "c1", description: "Water", amount: "100.00", sstRate: "0", sstAmount: "0.00",
      categoryName: "Utilities", paid: "50.00", outstanding: "27.00",
      originalAmount: "100.00", debitAdjustmentAmount: "0.00", creditAdjustmentAmount: "23.00",
      netAdjustmentAmount: "-23.00", adjustedAmount: "77.00", allocationBasis: "exact" as const,
      adjustments: [{ noteId: "cn1", docType: "credit_note" as const, documentNumber: "CN-0002", amountCents: 2300 }],
      attachments: [],
    },
    {
      id: "l2", chargeId: "c2", description: "Rent", amount: "150.00", sstRate: "0", sstAmount: "0.00",
      categoryName: "Rental", paid: "100.00", outstanding: "50.00",
      originalAmount: "150.00", debitAdjustmentAmount: "0.00", creditAdjustmentAmount: "0.00",
      netAdjustmentAmount: "0.00", adjustedAmount: "150.00", allocationBasis: "exact" as const,
      adjustments: [],
      attachments: [],
    },
  ],
  relatedDocuments: [
    { id: "cn1", docType: "credit_note", documentNumber: "CN-0002", status: "issued" },
    { id: "dn1", docType: "debit_note", documentNumber: "DN-0007", status: "issued" },
  ],
};

vi.mock("../../../api/billing-documents", () => ({
  useBillingDocument: () => ({ isLoading: false, data: { data: detail } }),
  fetchBillingDocumentPdfUrl: vi.fn(),
  useVoidChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateChargeAdjustment: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The Payments tab now embeds a real record-payment form (invoice-adjustments
// rework, Change 2) — mock its hooks so switching to that tab doesn't hit the
// real api-client module.
vi.mock("../../../api/accounting", () => ({
  useRecordInvoicePayment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  uploadSlipProof: vi.fn(async () => "orgs/o/refund-proofs/slip.jpg"),
  deleteSlipProof: vi.fn(async () => {}),
}));

async function mount(overrideDoc: BillingDocumentListItem = doc) {
  const { DocumentDetailDrawer } = await import("../document-detail-drawer");
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DocumentDetailDrawer doc={overrideDoc} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllEnvs());

describe("DocumentDetailDrawer — flag OFF (default)", () => {
  it("renders the pre-cut single-scroll layout — no tablist", async () => {
    await mount();
    expect(screen.queryByRole("tablist")).toBeNull();
    // The old heading + Amount/Paid/Outstanding columns (not the new tab table).
    expect(screen.getByText("Line items")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Original" })).toBeNull();
  });
});

describe("DocumentDetailDrawer — flag ON (VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS)", () => {
  beforeEach(() => vi.stubEnv("VITE_ENABLE_PHASE2_INVOICE_ADJUSTMENTS", "true"));

  it("renders the four-tab tablist with Line items selected by default", async () => {
    await mount();
    const tablist = screen.getByRole("tablist", { name: "Document details" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Line items", "Payments", "Adjustments", "Activity"]);
    const lineItemsTab = within(tablist).getByRole("tab", { name: "Line items" });
    expect(lineItemsTab).toHaveAttribute("aria-selected", "true");
    expect(lineItemsTab).toHaveAttribute("tabindex", "0");
    expect(within(tablist).getByRole("tab", { name: "Payments" })).toHaveAttribute("tabindex", "-1");
    // Default panel content: the new server-derived column set.
    expect(screen.getByRole("columnheader", { name: "Original" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Adjusted" })).toBeInTheDocument();
  });

  it("switches panels on tab click (Payments, Adjustments, Activity all reachable)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Payments" }));
    expect(screen.getByRole("tab", { name: "Payments" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Amount paid")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Original" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Adjustments" }));
    expect(screen.getByRole("tab", { name: "Adjustments" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("CN-0002")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No recorded activity yet.")).toBeInTheDocument();
  });

  it("moves selection with ArrowRight/ArrowLeft/Home/End (roving tabIndex)", async () => {
    await mount();
    const tablist = screen.getByRole("tablist", { name: "Document details" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Payments" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "End" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Line items" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true"); // wraps
  });

  it("renders the server adjustedAmount verbatim (never original+net computed in JS) and a subordinate CN child row with the signed amount", async () => {
    await mount();
    const row = screen.getByText("Water").closest("tr")!;
    const cells = row.querySelectorAll("td");
    // [#, Description, Original, SST, Adjustments, Adjusted, Paid, Outstanding]
    expect(cells[2].textContent).toMatch(/RM\s?100\.00/); // original
    expect(cells[4].textContent).toMatch(/−\s?RM\s?23\.00/); // net adjustment, signed
    expect(cells[5].textContent).toMatch(/RM\s?77\.00/); // adjusted — the SERVER string, verbatim

    // Subordinate child row beneath the Water line, with its own signed amount.
    const childLabel = screen.getByText(/↳ Credit Note CN-0002/);
    const childCells = childLabel.closest("tr")!.querySelectorAll("td");
    expect(childCells[3].textContent).toMatch(/−\s?RM\s?23\.00/);
  });

  it("a line with no adjustments shows no child row and an em-dash in the Adjustments column", async () => {
    await mount();
    const row = screen.getByText("Rent").closest("tr")!;
    const cells = row.querySelectorAll("td");
    // cells[4] = Adjustments (cells[3] is the SST column).
    expect(cells[4].textContent).toContain("—");
    expect(screen.queryByText(/↳ .*Rent/)).toBeNull();
  });

  it("Adjustments tab lists the related credit note AND debit note rows", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Adjustments" }));
    const panel = screen.getByRole("tabpanel"); // only the active (non-hidden) panel is queryable
    expect(within(panel).getByText("CN-0002")).toBeInTheDocument();
    expect(within(panel).getByText("DN-0007")).toBeInTheDocument();
    expect(within(panel).getAllByText("Issued")).toHaveLength(2);
  });

  it("Adjustments tab renders the inline add-row for an OWNER invoice too (seam #4 — canCreateNotes gate widened)", async () => {
    const ownerDoc: BillingDocumentListItem = { ...doc, counterpartyType: "owner" };
    await mount(ownerDoc);
    fireEvent.click(screen.getByRole("tab", { name: "Adjustments" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });
});
