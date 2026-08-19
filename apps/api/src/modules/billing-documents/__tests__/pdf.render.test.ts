import { describe, it, expect } from "vitest";
import { renderBillingDocumentHtml, type BillingDocumentPdfModel } from "../pdf.service";

const model: BillingDocumentPdfModel = {
  docType: "debit_note",
  title: "DEBIT NOTE",
  documentNumber: "DEP-0007",
  issuedAt: "2026-07-02",
  billingMonth: "July 2026",
  counterpartyName: "Tenant A",
  unitCode: "A-19-02-R1",
  reason: null,
  originalDocumentNumber: null,
  lines: [
    { description: "Monthly rental 2026-07", amount: "980.00", sstRate: "0", sstAmount: "0.00", attachmentFilenames: [], unitCode: null },
  ],
  totals: { subtotal: "980.00", sst: "0.00", total: "980.00" },
  adjustments: [],
  adjustedTotal: null,
  // Appended-bill pages are merged onto the rendered bytes, not into the HTML —
  // these render-only checks never exercise them.
  attachments: [],
};

describe("renderBillingDocumentHtml", () => {
  it("renders number, counterparty, unit, line and totals", () => {
    const html = renderBillingDocumentHtml(model, null);
    expect(html).toContain("DEP-0007");
    expect(html).toContain("DEBIT NOTE");
    expect(html).toContain("Tenant A");
    expect(html).toContain("A-19-02-R1");
    expect(html).toContain("Monthly rental 2026-07");
    expect(html).toContain("RM 980.00");
    expect(html).toContain("This is a computer-generated document. No signature required.");
  });

  it("escapes HTML in user-controlled fields", () => {
    const evil = { ...model, counterpartyName: `<script>alert("x")</script>` };
    const html = renderBillingDocumentHtml(evil, null);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("lists attachment filenames under the line (filenames only, no img tags)", () => {
    const withAttachment: BillingDocumentPdfModel = {
      ...model,
      lines: [{ ...model.lines[0], attachmentFilenames: ["slip.pdf", "quote.pdf"] }],
    };
    const html = renderBillingDocumentHtml(withAttachment, null);
    expect(html).toContain("Attachment: slip.pdf");
    expect(html).toContain("Attachment: quote.pdf");
    expect(html).not.toContain("<img");
  });

  // A COMBINED owner statement mints ONE IVOWN spanning every unit, so the
  // document-level unitCode is null and each line must name its own unit —
  // otherwise three "Management fee" lines read identically on the PDF the
  // owner actually receives.
  it("names each line's unit when the document spans several units", () => {
    const combined: BillingDocumentPdfModel = {
      ...model,
      docType: "invoice",
      title: "INVOICE",
      documentNumber: "IVOWN-0001",
      counterpartyName: "Demo Owner",
      unitCode: null,
      lines: [
        { description: "Management fee", amount: "220.00", sstRate: "8", sstAmount: "17.60", attachmentFilenames: [], unitCode: "A-01-01" },
        { description: "Management fee", amount: "220.00", sstRate: "8", sstAmount: "17.60", attachmentFilenames: [], unitCode: "A-01-02" },
        { description: "Management fee", amount: "150.00", sstRate: "8", sstAmount: "12.00", attachmentFilenames: [], unitCode: "B-02-07 · Master Room" },
      ],
      totals: { subtotal: "590.00", sst: "47.20", total: "637.20" },
      adjustments: [],
      adjustedTotal: null,
    };
    const html = renderBillingDocumentHtml(combined, null);
    expect(html).toContain("A-01-01");
    expect(html).toContain("A-01-02");
    expect(html).toContain("B-02-07 · Master Room");
  });

  it("omits the per-line unit when the line has none", () => {
    const noUnit: BillingDocumentPdfModel = {
      ...model,
      lines: [{ ...model.lines[0], unitCode: null }],
    };
    const html = renderBillingDocumentHtml(noUnit, null);
    expect(html).toContain("Monthly rental 2026-07");
    // The class always exists in the stylesheet — assert no unit DIV is emitted.
    expect(html).not.toContain(`<div class="line-unit">`);
  });

  it("credit note shows the original reference + reason", () => {
    const cn: BillingDocumentPdfModel = {
      ...model,
      docType: "credit_note",
      title: "CREDIT NOTE",
      documentNumber: "CN-0001",
      originalDocumentNumber: "DEP-0007",
      reason: "posted in error",
    };
    const html = renderBillingDocumentHtml(cn, null);
    expect(html).toContain("CN-0001");
    expect(html).toContain("Original document: DEP-0007");
    expect(html).toContain("posted in error");
  });
});
