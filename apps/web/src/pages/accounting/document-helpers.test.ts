import { describe, it, expect } from "vitest";
import { documentKindLabel } from "./document-helpers";

describe("documentKindLabel (P2 Rental Bill)", () => {
  it("labels RB docs 'Rental Bill' regardless of the internal docType", () => {
    expect(documentKindLabel("debit_note", "RB-0001")).toBe("Rental Bill");
    expect(documentKindLabel("invoice", "RB-0042")).toBe("Rental Bill");
  });

  it("still labels legacy IVREN docs 'Rental Bill' (immutable historical numbers)", () => {
    expect(documentKindLabel("debit_note", "IVREN-0001")).toBe("Rental Bill");
  });

  it("labels EB (Expense Bill) docs 'Expense Bill', never 'Invoice' (their docType is 'invoice')", () => {
    expect(documentKindLabel("invoice", "EB-0002")).toBe("Expense Bill");
    expect(documentKindLabel("invoice", "EBX-1")).toBe("Invoice"); // "EB" prefix guard: EBX is NOT an expense bill
  });

  it("falls back to docTypeLabel for every other series", () => {
    expect(documentKindLabel("invoice", "IVTEN-0001")).toBe("Invoice");
    expect(documentKindLabel("debit_note", "DEP-0007")).toBe("Debit Note");
    expect(documentKindLabel("credit_note", "CN-0003")).toBe("Credit Note");
    expect(documentKindLabel("receipt", "RCPT-0009")).toBe("Receipt");
    expect(documentKindLabel("invoice", "RBX-1")).toBe("Invoice"); // "RB-" prefix guard: RBX is NOT a rental bill
    expect(documentKindLabel("invoice", "IVRENX-1")).toBe("Invoice"); // legacy "IVREN-" prefix guard: IVRENX is NOT a rental bill
  });

  it("handles a missing documentNumber (falls back to docType)", () => {
    expect(documentKindLabel("invoice")).toBe("Invoice");
    expect(documentKindLabel("invoice", null)).toBe("Invoice");
  });

  it("labels an OEA document as Owner Expense Advice, never Invoice", () => {
    expect(documentKindLabel("owner_expense_advice", "OEA-0001")).toBe("Owner Expense Advice");
  });

  it("still labels an OEA by its docType when the series prefix does not match", () => {
    // The docType alone carries the identity, so the "OEA-" prefix guard cannot
    // downgrade it to a raw value the way EBX- falls back to "Invoice".
    expect(documentKindLabel("owner_expense_advice", "OEAX-0001")).toBe("Owner Expense Advice");
  });

  it("falls back to the raw value for a genuinely unknown docType", () => {
    expect(documentKindLabel("nonsense_type", "ZZZ-0001")).toBe("nonsense_type");
  });
});
