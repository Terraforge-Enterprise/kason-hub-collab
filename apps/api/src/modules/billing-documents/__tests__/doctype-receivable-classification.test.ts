// Every BillingDocument docType, classified as receivable or not — deliberately.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// The proforma spec assumed widening BILLING_DOC_TYPES would be self-policing:
// "an exhaustiveness anchor: every Record<BillingDocType, …> fails to compile until
// `proforma` is answered, which is the intended forcing function."
//
// No such Record exists. `grep -rn "Record<BillingDocType"` over apps and packages
// returns nothing, and adding "proforma" to BILLING_DOC_TYPES produced ZERO type errors
// in either app. The real anchor is a TEST, not a type: receipt-doctype-maps.test.ts
// iterates BILLING_DOC_TYPES and fails when the PDF title/letterhead maps miss a value —
// which is what caught proforma. Its reach stops at those two maps.
//
// Everything else about a docType is a runtime string comparison, so the SEMANTIC
// question — does this docType carry money? — had no anchor at all. This table is that
// anchor: a Record over the union, so a NEW docType is a compile error here (missing
// key) and a MISCLASSIFIED one is a test failure.
//
// Worth knowing when adding the next docType: allowlists (`docType: { in: [...] }`)
// exclude it for free, denylists do NOT. Adding proforma required naming it explicitly
// in two denylists — billing/billing.repository.ts's findDocumentsByChargeIds and
// billing-documents/overpayment-cn.service.ts — neither of which this table can catch.
import { describe, it, expect } from "vitest";
import { BILLING_DOC_TYPES, type BillingDocType } from "@kason/shared";
import { isNonReceivableDocType } from "../status.service";

/**
 * TRUE = this docType establishes a RECEIVABLE (settlement is derived on it; it counts
 * in Σ over documents). FALSE = it does not.
 *
 * A `Record` over the union, not a list: adding a docType without answering it here
 * fails to compile, which is the check the spec assumed already existed elsewhere.
 */
const IS_RECEIVABLE: Record<BillingDocType, boolean> = {
  invoice: true,               // the receivable itself
  debit_note: true,            // an additional receivable against the same tenancy
  credit_note: false,          // reduces a receivable; never one itself
  refund_note: false,          // evidence money went back out
  receipt: false,              // acknowledges a receivable already settled
  owner_expense_advice: false, // evidence of a payout deduction, never billed to the owner
  // Proforma spec R2. THE invariant of the whole proforma model: a proforma and the
  // invoice graduated from it reference the SAME charges. If settlement were derived on
  // both, every Σ over documents would count that money twice.
  proforma: false,
};

describe("docType receivable classification", () => {
  it("classifies every docType in BILLING_DOC_TYPES", () => {
    // Guards the other direction from the Record: a docType REMOVED from the union but
    // left here, or (with a loosened type) one present in the union and missing here.
    expect(Object.keys(IS_RECEIVABLE).sort()).toEqual([...BILLING_DOC_TYPES].sort());
  });

  for (const docType of BILLING_DOC_TYPES) {
    it(`${docType} → ${IS_RECEIVABLE[docType] ? "receivable" : "NON-receivable"}`, () => {
      expect(isNonReceivableDocType(docType)).toBe(!IS_RECEIVABLE[docType]);
    });
  }

  it("proforma is non-receivable — the single guard against double-counting graduation", () => {
    // Called out separately from the loop because this one assertion is what prevents a
    // proforma and its graduated invoice both reading "settled" off the same charges.
    expect(isNonReceivableDocType("proforma")).toBe(true);
    expect(isNonReceivableDocType("invoice")).toBe(false);
  });

  it("an UNKNOWN docType defaults to receivable (visible-and-wrong, not invisible-and-wrong)", () => {
    // isNonReceivableDocType is an allowlist of non-receivables by design: a docType
    // nobody has classified shows up in the numbers looking wrong, rather than vanishing
    // from them and looking right. Pinned so the default is never quietly inverted.
    expect(isNonReceivableDocType("some_future_doctype")).toBe(false);
  });
});
