import { describe, it, expect } from "vitest";
import { resolveDocTitle, DOC_TITLE } from "../pdf.service";

describe("resolveDocTitle (P2 Rental Bill)", () => {
  it("renders 'RENTAL BILL' for RB docs regardless of the internal docType", () => {
    // Rent stays a debit_note internally (avoids owner-ledger sign ripple); the
    // RB series is the customer identity → the PDF title reads RENTAL BILL.
    expect(resolveDocTitle("debit_note", "RB-0001")).toBe("RENTAL BILL");
    expect(resolveDocTitle("invoice", "RB-0099")).toBe("RENTAL BILL");
  });

  it("still renders 'RENTAL BILL' for legacy IVREN docs (immutable historical numbers)", () => {
    // Pre-rename IVREN-numbered docs stay valid → IVREN kept as a legacy alias in the title map.
    expect(resolveDocTitle("debit_note", "IVREN-0001")).toBe("RENTAL BILL");
  });

  it("renders 'EXPENSE BILL' for EB docs, never 'INVOICE' (their docType is 'invoice')", () => {
    // EB is a tenant expense RECOVERY on its own series; docType stays "invoice" but the
    // customer identity is the EB series → the PDF title must read EXPENSE BILL, not INVOICE.
    expect(resolveDocTitle("invoice", "EB-0002")).toBe("EXPENSE BILL");
    expect(resolveDocTitle("invoice", "EBX-1")).toBe(DOC_TITLE.invoice); // "EB" prefix guard
  });

  it("uses the docType title map for every other series", () => {
    expect(resolveDocTitle("invoice", "IVTEN-0001")).toBe(DOC_TITLE.invoice);
    expect(resolveDocTitle("debit_note", "DEP-0007")).toBe(DOC_TITLE.debit_note);
    expect(resolveDocTitle("credit_note", "CN-0001")).toBe(DOC_TITLE.credit_note);
    expect(resolveDocTitle("refund_note", "RN-0001")).toBe(DOC_TITLE.refund_note);
    expect(resolveDocTitle("receipt", "RCPT-0001")).toBe(DOC_TITLE.receipt);
    expect(resolveDocTitle("invoice", "RBX-1")).toBe(DOC_TITLE.invoice); // "RB-" prefix guard
    expect(resolveDocTitle("invoice", "IVRENX-1")).toBe(DOC_TITLE.invoice); // legacy "IVREN-" prefix guard
  });
});
