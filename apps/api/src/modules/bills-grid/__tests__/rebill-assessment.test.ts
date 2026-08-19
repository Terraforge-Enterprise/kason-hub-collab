import { describe, expect, it } from "vitest";
import { assessPaidBlockers } from "../rebill-assessment";

// A live reclaimable charge always carries its OWN document id (service.ts pushes
// `documentId: doc.id` alongside each reclaimable charge). `documentId` defaults to null so the
// doc-less shape (legacy owner-borne) can still be modelled. `doc`'s id defaults to its
// documentNumber, so a charge references its document by passing that number as `documentId`.
const T = (id: string, partyId: string, amount: number, documentId: string | null = null) => ({ id, partyId, family: "tenant_income", amount, documentId });
const O = (id: string, partyId: string, amount: number, documentId: string | null = null) => ({ id, partyId, family: "owner_income", amount, documentId });
const doc = (counterpartyType: string, documentNumber: string, partyId: string, id: string = documentNumber) => ({ id, counterpartyType, documentNumber, partyId });

describe("assessPaidBlockers", () => {
  it("no payments → no blockers", () => {
    const res = assessPaidBlockers({ charges: [T("c1", "pA", 1000, "IVTEN-1")], docs: [doc("tenant", "IVTEN-1", "pA")], activePaidByChargeId: new Map() });
    expect(res.paidBlockers).toEqual([]);
  });

  it("partial tenant payment → one 'partial' blocker naming the invoice + both amounts", () => {
    const res = assessPaidBlockers({
      charges: [T("c1", "pA", 1000, "IVTEN-0004"), T("c2", "pA", 500, "IVTEN-0004")],
      docs: [doc("tenant", "IVTEN-0004", "pA")],
      activePaidByChargeId: new Map([["c1", 1200]]),
    });
    expect(res.paidBlockers).toEqual([
      { counterparty: "tenant", documentId: "IVTEN-0004", invoiceNumber: "IVTEN-0004", paidAmount: 1200, invoiceTotal: 1500, paymentState: "partial" },
    ]);
  });

  it("full payment → paymentState 'paid'", () => {
    const res = assessPaidBlockers({ charges: [T("c1", "pA", 300, "IVTEN-1")], docs: [doc("tenant", "IVTEN-1", "pA")], activePaidByChargeId: new Map([["c1", 300]]) });
    expect(res.paidBlockers[0].paymentState).toBe("paid");
  });

  it("owner payment → counterparty is 'owner', not tenant", () => {
    const res = assessPaidBlockers({ charges: [O("c1", "pO", 300, "IVOWN-0007")], docs: [doc("owner", "IVOWN-0007", "pO")], activePaidByChargeId: new Map([["c1", 300]]) });
    expect(res.paidBlockers).toEqual([{ counterparty: "owner", documentId: "IVOWN-0007", invoiceNumber: "IVOWN-0007", paidAmount: 300, invoiceTotal: 300, paymentState: "paid" }]);
  });

  it("partitioned unit → only the paid tenant's invoice blocks; the unpaid roommate is not listed", () => {
    const res = assessPaidBlockers({
      charges: [T("a1", "pA", 1000, "IVTEN-A"), T("b1", "pB", 1000, "IVTEN-B")],
      docs: [doc("tenant", "IVTEN-A", "pA"), doc("tenant", "IVTEN-B", "pB")],
      activePaidByChargeId: new Map([["a1", 1000]]),
    });
    expect(res.paidBlockers).toEqual([{ counterparty: "tenant", documentId: "IVTEN-A", invoiceNumber: "IVTEN-A", paidAmount: 1000, invoiceTotal: 1000, paymentState: "paid" }]);
  });

  it("tenant utility invoice + tenant Expense Bill sharing (tenant, partyId) → each doc grouped separately; only the paid EB blocks, named correctly", () => {
    // One unit-month, one tenant party pA, TWO live tenant docs: a utility invoice (IVTEN-1,
    // 1000) and a tenant Expense Bill (EB-1, 200) — the ENABLE_EXPENSE_BILL shape. Only the EB
    // is paid. The blocker must name EB-1 with its OWN total (200/200 paid), NOT collapse both
    // charges onto the first doc (IVTEN-1) and report an inflated 200/1200 "partial".
    const res = assessPaidBlockers({
      charges: [T("cUtil", "pA", 1000, "IVTEN-1"), T("cExp", "pA", 200, "EB-1")],
      docs: [doc("tenant", "IVTEN-1", "pA"), doc("tenant", "EB-1", "pA")],
      activePaidByChargeId: new Map([["cExp", 200]]),
    });
    expect(res.paidBlockers).toEqual([
      { counterparty: "tenant", documentId: "EB-1", invoiceNumber: "EB-1", paidAmount: 200, invoiceTotal: 200, paymentState: "paid" },
    ]);
    // The unpaid utility invoice must NOT be named — naming it would mislead the admin and
    // inflate the reported total, defeating the block message's purpose.
    expect(res.paidBlockers.some((b) => b.invoiceNumber === "IVTEN-1")).toBe(false);
  });

  it("both tenant and owner paid → two blockers", () => {
    const res = assessPaidBlockers({
      charges: [T("t1", "pA", 1000, "IVTEN-1"), O("o1", "pO", 300, "IVOWN-1")],
      docs: [doc("tenant", "IVTEN-1", "pA"), doc("owner", "IVOWN-1", "pO")],
      activePaidByChargeId: new Map([["t1", 1000], ["o1", 300]]),
    });
    expect(res.paidBlockers.map((b) => b.counterparty).sort()).toEqual(["owner", "tenant"]);
  });

  it("doc-less paid charge → blocker with invoiceNumber null, counterparty from family", () => {
    const res = assessPaidBlockers({ charges: [O("c1", "pO", 300)], docs: [], activePaidByChargeId: new Map([["c1", 300]]) });
    expect(res.paidBlockers).toEqual([{ counterparty: "owner", documentId: null, invoiceNumber: null, paidAmount: 300, invoiceTotal: 300, paymentState: "paid" }]);
  });

  it("net 0 (fully reversed) → no blocker", () => {
    const res = assessPaidBlockers({ charges: [T("c1", "pA", 1000, "IVTEN-1")], docs: [doc("tenant", "IVTEN-1", "pA")], activePaidByChargeId: new Map([["c1", 0]]) });
    expect(res.paidBlockers).toEqual([]);
  });
});
