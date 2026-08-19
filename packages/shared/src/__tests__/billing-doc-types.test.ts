import { describe, it, expect } from "vitest";
import { BILLING_DOC_TYPES } from "../schemas/charge-categories";

describe("BILLING_DOC_TYPES", () => {
  it("includes receipt and owner_expense_advice alongside the four original docTypes", () => {
    expect([...BILLING_DOC_TYPES]).toEqual([
      "invoice", "debit_note", "credit_note", "refund_note", "receipt", "owner_expense_advice",
    ]);
  });

  it("does not contain a mis-spelled value", () => {
    expect((BILLING_DOC_TYPES as readonly string[]).includes("reciept")).toBe(false);
  });
});
