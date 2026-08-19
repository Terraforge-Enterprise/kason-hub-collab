import { describe, expect, it } from "vitest";
import { isNonReceivableDocType } from "../status.service";

/**
 * OEA carries no payment axis (R3).
 *
 * An Owner Expense Advice records money already DEDUCTED from the owner's payout. It is
 * not a receivable, so settlement derivation must skip it exactly as it skips
 * receipt/credit_note/refund_note — otherwise the register would show an OEA as
 * "Unpaid" and it would pollute the owner's outstanding balance.
 *
 * Imports the real predicate rather than mirroring it, so this fails if the skip list
 * ever drops the docType.
 */
describe("settlement derivation skip list", () => {
  it("skips an OEA — evidence of a deduction, never a receivable", () => {
    expect(isNonReceivableDocType("owner_expense_advice")).toBe(true);
  });

  it("still skips the existing non-receivables", () => {
    expect(isNonReceivableDocType("credit_note")).toBe(true);
    expect(isNonReceivableDocType("refund_note")).toBe(true);
    expect(isNonReceivableDocType("receipt")).toBe(true);
  });

  it("does NOT skip a real receivable — the skip must not over-match", () => {
    expect(isNonReceivableDocType("invoice")).toBe(false);
    expect(isNonReceivableDocType("debit_note")).toBe(false);
  });
});
