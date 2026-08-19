import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentListItem } from "@kason/shared";

// Detail with four lines: unpaid, partially paid, fully paid, and one carrying
// two source-expense attachments (bill-expenses R6).
vi.mock("../../../api/billing-documents", () => ({
  useBillingDocument: () => ({
    isLoading: false,
    data: { data: {
      id: "d1", docType: "invoice", documentNumber: "IVTEN-0009", seriesCode: "IVTEN",
      status: "partially_settled", documentStatus: "ISSUED", taxStatus: "none", settlementStatus: "PARTIALLY_PAID",
      counterpartyType: "tenant", partyId: "p1", partyName: "Tenant Nine",
      propertyName: "PV9", unitCode: "A-08-03", billingMonth: "2026-07-01", issuedAt: "2026-07-19T00:00:00.000Z",
      total: "250.00", subtotal: "250.00", sstAmount: "0.00", creditAmount: null,
      amountPaid: "190.00", balance: "60.00", reason: null, statementInvoiceId: null, hasPdf: false,
      originalDocumentNumber: null, paymentId: null,
      lines: [
        { id: "l1", chargeId: "c1", description: "Cleaning A", amount: "100.00", sstRate: "0", sstAmount: "0.00", categoryName: "Cleaning", paid: "0.00", outstanding: "100.00", attachments: [] },
        { id: "l2", chargeId: "c2", description: "Cleaning B", amount: "100.00", sstRate: "0", sstAmount: "0.00", categoryName: "Cleaning", paid: "40.00", outstanding: "60.00", attachments: [] },
        { id: "l3", chargeId: "c3", description: "WiFi 202607", amount: "150.00", sstRate: "0", sstAmount: "0.00", categoryName: "WiFi", paid: "150.00", outstanding: "0.00", attachments: [] },
        { id: "l4", chargeId: "c4", description: "Plumbing repair", amount: "80.00", sstRate: "0", sstAmount: "0.00", categoryName: "Repairs", paid: "0.00", outstanding: "80.00", attachments: [{ id: "a1", filename: "slip.pdf" }, { id: "a2", filename: "receipt.jpg" }] },
      ],
      relatedDocuments: [],
    } },
  }),
  fetchBillingDocumentPdfUrl: vi.fn(),
  fetchBillingDocumentAttachmentUrl: vi.fn(async () => "https://signed.example/slip.pdf"),
}));

import { fetchBillingDocumentAttachmentUrl } from "../../../api/billing-documents";

const doc: BillingDocumentListItem = {
  id: "d1", docType: "invoice", documentNumber: "IVTEN-0009", seriesCode: "IVTEN",
  status: "partially_settled", documentStatus: "ISSUED", taxStatus: "none", settlementStatus: "PARTIALLY_PAID",
  issuedAt: "2026-07-19T00:00:00.000Z", billingMonth: "2026-07-01", counterpartyType: "tenant",
  partyId: "p1", partyName: "Tenant Nine", unitCode: "A-08-03", propertyName: "PV9",
  total: "250.00", originalDocumentNumber: null, paymentId: null,
} as unknown as BillingDocumentListItem;

async function mount() {
  const { DocumentDetailDrawer } = await import("../document-detail-drawer");
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DocumentDetailDrawer doc={doc} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** Money cells by column: [#, Description, Amount, SST, Paid, Outstanding]. */
function cellsFor(desc: string): NodeListOf<HTMLTableCellElement> {
  return screen.getByText(desc).closest("tr")!.querySelectorAll("td");
}

describe("DocumentDetailDrawer line-level Paid/Outstanding", () => {
  it("shows Amount, Paid (RM0.00, never a dash) and Outstanding per line", async () => {
    await mount();
    const c = cellsFor("Cleaning A");
    expect(c[2].textContent).toMatch(/RM\s?100\.00/); // amount
    expect(c[4].textContent).toMatch(/RM\s?0\.00/);   // paid = RM0.00…
    expect(c[4].textContent).not.toContain("—");      // …never a dash
    expect(c[5].textContent).toMatch(/RM\s?100\.00/); // outstanding
  });

  it("shows the partially-paid split (Amount 100 · Paid 40 · Outstanding 60)", async () => {
    await mount();
    const c = cellsFor("Cleaning B");
    expect(c[2].textContent).toMatch(/RM\s?100\.00/);
    expect(c[4].textContent).toMatch(/RM\s?40\.00/);
    expect(c[5].textContent).toMatch(/RM\s?60\.00/);
    // Not fully paid → no Paid chip on this row.
    expect(within(screen.getByText("Cleaning B").closest("tr")!).queryByText(/^Paid$/)).toBeNull();
  });

  it("marks a fully-paid line with a Paid chip and RM0.00 outstanding", async () => {
    await mount();
    const c = cellsFor("WiFi 202607");
    expect(c[2].textContent).toMatch(/RM\s?150\.00/); // amount
    expect(c[4].textContent).toMatch(/RM\s?150\.00/); // paid
    expect(c[5].textContent).toMatch(/RM\s?0\.00/);   // outstanding 0
    expect(within(screen.getByText("WiFi 202607").closest("tr")!).getByText(/^Paid$/)).toBeInTheDocument();
  });

  it("shows invoice totals: Total, Amount paid and Balance due", async () => {
    await mount();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Amount paid")).toBeInTheDocument();
    expect(screen.getByText("Balance due")).toBeInTheDocument();
  });
});

describe("DocumentDetailDrawer line attachments (bill-expenses R6)", () => {
  beforeEach(() => {
    vi.mocked(fetchBillingDocumentAttachmentUrl).mockClear();
  });

  it("renders line attachments", async () => {
    await mount();
    expect(screen.getByText("slip.pdf")).toBeInTheDocument();
    expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
  });

  it("no attachments no affordance", async () => {
    await mount();
    // Cleaning A carries attachments: [] — its row has no attachment buttons.
    const row = screen.getByText("Cleaning A").closest("tr")!;
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("click fetches signed url", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockReturnValue(null);
    await mount();
    fireEvent.click(screen.getByText("slip.pdf"));
    await waitFor(() => {
      expect(fetchBillingDocumentAttachmentUrl).toHaveBeenCalledWith("d1", "a1");
    });
    expect(windowOpenSpy).toHaveBeenCalledWith(
      "https://signed.example/slip.pdf",
      "_blank",
      "noopener,noreferrer",
    );
    windowOpenSpy.mockRestore();
  });
});
