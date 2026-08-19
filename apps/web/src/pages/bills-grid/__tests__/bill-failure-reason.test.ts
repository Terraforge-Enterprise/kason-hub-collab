import { describe, expect, it } from "vitest";
import { billFailureReason } from "../bill-failure-reason";
import type { BillRowResult } from "@/api/bills-grid";

const base = (over: Partial<BillRowResult>): BillRowResult => ({ apartmentId: "a1", outcome: "rebill_blocked_payment_exists", ...over });

describe("billFailureReason — rebill_blocked_payment_exists", () => {
  it("partial tenant: counterparty + invoice + PARTIALLY PAID + both amounts + CN/DN", () => {
    const msg = billFailureReason(base({ paidBlockers: [{ counterparty: "tenant", documentId: "IVTEN-0004", invoiceNumber: "IVTEN-0004", paidAmount: 1200, invoiceTotal: 1500, paymentState: "partial" }] }));
    expect(msg).toContain("tenant invoice IVTEN-0004");
    expect(msg).toContain("PARTIALLY PAID");
    expect(msg).toContain("RM 1,200.00");
    expect(msg).toContain("RM 1,500.00");
    expect(msg).toMatch(/Credit\/Debit Note/i);
  });

  it("owner paid: says 'owner', not 'tenant'", () => {
    const msg = billFailureReason(base({ paidBlockers: [{ counterparty: "owner", documentId: "IVOWN-0007", invoiceNumber: "IVOWN-0007", paidAmount: 300, invoiceTotal: 300, paymentState: "paid" }] }));
    expect(msg).toContain("owner invoice IVOWN-0007");
    expect(msg).toContain("PAID IN FULL");
    expect(msg).not.toContain("tenant");
  });

  it("multiple blockers are listed and joined", () => {
    const msg = billFailureReason(base({ paidBlockers: [
      { counterparty: "tenant", documentId: "IVTEN-A", invoiceNumber: "IVTEN-A", paidAmount: 1000, invoiceTotal: 1000, paymentState: "paid" },
      { counterparty: "owner", documentId: "IVOWN-1", invoiceNumber: "IVOWN-1", paidAmount: 300, invoiceTotal: 600, paymentState: "partial" },
    ] }));
    expect(msg).toContain("IVTEN-A");
    expect(msg).toContain("IVOWN-1");
    expect(msg).toContain(" · ");
  });

  it("fallback when paidBlockers absent (older payload)", () => {
    const msg = billFailureReason(base({}));
    expect(msg).toMatch(/Credit\/Debit Note/i);
    expect(msg).not.toContain("undefined");
  });
});
