// Pure-render checks for the CN/DN-aware invoice PDF (no Chromium, no DB):
// adjustment rows + Adjusted Total appear when notes exist, the plain Total
// stays the grand row when they don't, and the letterhead uses the centered
// grid every sibling document uses (the flex band drifted left — punch list D).
import { describe, expect, it } from "vitest";
import { renderBillingDocumentHtml, type BillingDocumentPdfModel } from "../pdf.service";

function model(overrides: Partial<BillingDocumentPdfModel> = {}): BillingDocumentPdfModel {
  return {
    docType: "invoice",
    title: "INVOICE",
    documentNumber: "IVTEN-2026-0001",
    issuedAt: "2026-08-01",
    billingMonth: "July 2026",
    counterpartyName: "Tenant One",
    unitCode: "B-02-07",
    reason: null,
    originalDocumentNumber: null,
    lines: [
      { description: "Rent", amount: "800.00", sstRate: "0", sstAmount: "0.00", attachmentFilenames: [], unitCode: null },
    ],
    totals: { subtotal: "800.00", sst: "0.00", total: "800.00" },
    adjustments: [],
    adjustedTotal: null,
    // Appended-bill pages are merged onto the rendered bytes, not into the HTML —
    // these render-only checks never exercise them.
    attachments: [],
    ...overrides,
  };
}

describe("renderBillingDocumentHtml — CN/DN adjustments", () => {
  it("unadjusted: Total is the grand row, no adjustment rows", () => {
    const html = renderBillingDocumentHtml(model(), null);
    expect(html).toContain('<div class="totals-row grand"><span class="tot-label">Total</span>');
    expect(html).not.toContain("Adjusted Total");
    expect(html).not.toContain("Credit Note");
  });

  it("adjusted: one row per note (signed) and a grand Adjusted Total", () => {
    const html = renderBillingDocumentHtml(
      model({
        adjustments: [
          { documentNumber: "CN-2026-0001", docType: "credit_note", total: "100.00" },
          { documentNumber: "DN-2026-0001", docType: "debit_note", total: "50.00" },
        ],
        adjustedTotal: "750.00",
      }),
      null,
    );
    expect(html).toContain("Credit Note CN-2026-0001");
    expect(html).toContain("− RM 100.00");
    expect(html).toContain("Debit Note DN-2026-0001");
    expect(html).toContain("+ RM 50.00");
    expect(html).toContain('<div class="totals-row grand"><span class="tot-label">Adjusted Total</span><span class="tot-value">RM 750.00</span></div>');
    // The plain Total row is demoted to non-grand when an adjusted total exists.
    expect(html).not.toContain('<div class="totals-row grand"><span class="tot-label">Total</span>');
  });

  it("letterhead band uses the centered 1fr 2fr 1fr grid (no left-drifting flex)", () => {
    const html = renderBillingDocumentHtml(model(), null);
    expect(html).toContain("grid-template-columns: 1fr 2fr 1fr");
    expect(html).toContain(".lh-center { text-align: center }");
  });

  it("zero SST prints with the RM prefix like every other money cell", () => {
    const html = renderBillingDocumentHtml(model(), null);
    expect(html).toContain("RM 0.00");
    expect(html).not.toMatch(/>0\.00</);
  });
});
