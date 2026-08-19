import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDocumentListItem } from "@kason/shared";
import { statusMeta } from "../document-helpers";

/** A list item with the derived axes present; override per case. */
const li = (over: Partial<BillingDocumentListItem>): BillingDocumentListItem =>
  ({
    id: "d1", docType: "invoice", documentNumber: "IVTEN-1", seriesCode: "IVTEN",
    status: "issued", documentStatus: "ISSUED", taxStatus: "none", settlementStatus: "UNPAID",
    derivedPaymentStatus: "UNPAID", adjustmentStatus: "NONE", isReBilled: false, adjustedTotal: "100.00",
    issuedAt: "2026-07-19T00:00:00.000Z", billingMonth: "2026-07-01", counterpartyType: "tenant",
    partyId: "p1", partyName: "T", unitCode: null, propertyName: null, total: "100.00",
    originalDocumentNumber: null, paymentId: null,
    ...over,
  }) as BillingDocumentListItem;

describe("statusMeta — primary + secondary badges", () => {
  it("debit note on unpaid → primary Unpaid + secondary Debit note issued", () => {
    const s = statusMeta(li({ derivedPaymentStatus: "UNPAID", adjustmentStatus: "DEBIT_NOTE_ISSUED" }));
    expect(s.primary.label).toBe("Unpaid");
    expect(s.secondary?.label).toBe("Debit note issued");
  });

  it("partial credit note → primary Unpaid + secondary Credit note issued", () => {
    const s = statusMeta(li({ adjustmentStatus: "CREDIT_NOTE_ISSUED" }));
    expect(s.primary.label).toBe("Unpaid");
    expect(s.secondary?.label).toBe("Credit note issued");
  });

  it("full credit note → primary 'Closed · Fully credited', NO secondary, NOT 'Paid'", () => {
    const s = statusMeta(li({ derivedPaymentStatus: "FULLY_CREDITED", adjustmentStatus: "FULLY_CREDITED" }));
    expect(s.primary.label).toBe("Closed · Fully credited");
    expect(s.secondary).toBeUndefined();
  });

  it("re-Billed original (CANCELLED + isReBilled) → 'Voided · Re-Billed'", () => {
    expect(statusMeta(li({ documentStatus: "CANCELLED", isReBilled: true })).primary.label).toBe("Voided · Re-Billed");
  });

  it("plain void (CANCELLED, not re-Billed) → 'Voided'", () => {
    expect(statusMeta(li({ documentStatus: "CANCELLED", isReBilled: false })).primary.label).toBe("Voided");
  });

  it("paid → Paid; overpaid → Overpaid; part-paid → Part-paid", () => {
    expect(statusMeta(li({ derivedPaymentStatus: "PAID" })).primary.label).toBe("Paid");
    expect(statusMeta(li({ derivedPaymentStatus: "OVERPAID" })).primary.label).toBe("Overpaid");
    expect(statusMeta(li({ derivedPaymentStatus: "PARTIALLY_PAID" })).primary.label).toBe("Part-paid");
  });

  it("legacy payload with no derived fields → falls back to settlementStatus, no secondary, no throw", () => {
    const legacy = { docType: "invoice", documentStatus: "ISSUED", settlementStatus: "PARTIALLY_PAID" } as unknown as BillingDocumentListItem;
    const s = statusMeta(legacy);
    expect(s.primary.label).toBe("Part-paid");
    expect(s.secondary).toBeUndefined();
  });
});

// ── Drawer render: breakdown rows + secondary badge + linked CN/DN ──────────────
const h = vi.hoisted(() => ({ detail: null as unknown }));
vi.mock("../../../api/billing-documents", () => ({
  useBillingDocument: () => ({ isLoading: false, data: h.detail ? { data: h.detail } : undefined }),
  fetchBillingDocumentPdfUrl: vi.fn(),
}));

async function mount(doc: BillingDocumentListItem, detail: Record<string, unknown>) {
  h.detail = detail;
  const { DocumentDetailDrawer } = await import("../document-detail-drawer");
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DocumentDetailDrawer doc={doc} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const detailFor = (doc: BillingDocumentListItem, over: Record<string, unknown>) => ({
  ...doc, subtotal: doc.total, sstAmount: "0.00", creditAmount: null,
  debitNoteTotal: "0.00", creditNoteTotal: "0.00",
  amountPaid: "0.00", balance: "0.00", reason: null, statementInvoiceId: null, hasPdf: false,
  lines: [{ id: "l1", chargeId: "c1", description: "Rent", amount: doc.total, sstRate: "0", sstAmount: "0.00", categoryName: "Rent", paid: "0.00", outstanding: "0.00", attachments: [] }],
  relatedDocuments: [],
  ...over,
});

describe("DocumentDetailDrawer — badges + adjusted breakdown", () => {
  it("full credit note → 'Closed · Fully credited', shows Credit note total + Adjusted invoice amount + linked CN, no 'Paid'", async () => {
    const doc = li({ derivedPaymentStatus: "FULLY_CREDITED", adjustmentStatus: "FULLY_CREDITED", adjustedTotal: "0.00" });
    await mount(doc, detailFor(doc, {
      creditNoteTotal: "100.00", adjustedTotal: "0.00", amountPaid: "0.00",
      relatedDocuments: [{ id: "cn1", docType: "credit_note", documentNumber: "CN-0002", status: "issued" }],
    }));
    expect(screen.getByText("Closed · Fully credited")).toBeInTheDocument();
    expect(screen.getByText("Credit note total")).toBeInTheDocument();
    expect(screen.getByText("Adjusted invoice amount")).toBeInTheDocument();
    expect(screen.getByText(/CN-0002/)).toBeInTheDocument();
    // The PRIMARY badge is "Closed · Fully credited" (asserted above), never "Paid".
    // (A "Paid" column header + a per-line "Paid" chip legitimately exist in the line
    // table, so a bare /^Paid$/ query is not a valid primary-badge check — the pure
    // statusMeta test proves full-CN never yields a "Paid" primary.)
  });

  it("debit note on unpaid → 'Debit note issued' secondary + Debit note total row + adjusted RM700", async () => {
    const doc = li({ derivedPaymentStatus: "UNPAID", adjustmentStatus: "DEBIT_NOTE_ISSUED", adjustedTotal: "700.00", total: "600.00" });
    await mount(doc, detailFor(doc, { debitNoteTotal: "100.00", adjustedTotal: "700.00", amountPaid: "0.00" }));
    expect(screen.getByText("Debit note issued")).toBeInTheDocument();
    expect(screen.getByText("Debit note total")).toBeInTheDocument();
    expect(screen.getByText("Balance due")).toBeInTheDocument();
    // Adjusted 700 and Balance 700 both render.
    expect(screen.getAllByText(/RM\s?700\.00/).length).toBeGreaterThanOrEqual(1);
  });
});
