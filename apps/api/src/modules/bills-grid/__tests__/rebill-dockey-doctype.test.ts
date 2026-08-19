import { describe, expect, it } from "vitest";
import { reBillDocKey } from "../service";

/**
 * Re-Bill supersede key (R8).
 *
 * The key decides which FRESH document each CANCELLED document supersedes to. It
 * omitted docType, which was safe only while an owner could hold ONE document per
 * (party, unit, month). Once an owner can hold both an IVOWN receivable and an OEA
 * advice, the two collapse to one key and `freshByKey` (a Map) keeps only the last —
 * so the old documents supersede to the WRONG replacement, or to null.
 *
 * Imports the REAL key builder rather than mirroring it, so this test fails if the
 * implementation ever drops docType again.
 */
const base = {
  counterpartyType: "owner",
  partyId: "owner-1",
  listingId: "unit-1",
  billingMonth: new Date("2026-07-01T00:00:00.000Z"),
};

describe("reBillDocKey", () => {
  it("distinguishes an IVOWN invoice from an OEA advice in the same owner-unit-month", () => {
    expect(reBillDocKey({ ...base, docType: "invoice" }))
      .not.toBe(reBillDocKey({ ...base, docType: "owner_expense_advice" }));
  });

  it("keeps two documents of the SAME docType in the same slot colliding (unchanged)", () => {
    expect(reBillDocKey({ ...base, docType: "invoice" }))
      .toBe(reBillDocKey({ ...base, docType: "invoice" }));
  });

  it("does not resolve a fresh doc for an old doc whose docType has no replacement", () => {
    const freshByKey = new Map([[reBillDocKey({ ...base, docType: "invoice" }), "fresh-ivown"]]);
    expect(freshByKey.get(reBillDocKey({ ...base, docType: "owner_expense_advice" })) ?? null).toBeNull();
  });

  it("still separates tenant from owner, and month from month", () => {
    expect(reBillDocKey({ ...base, docType: "invoice" }))
      .not.toBe(reBillDocKey({ ...base, counterpartyType: "tenant", docType: "invoice" }));
    expect(reBillDocKey({ ...base, docType: "invoice" }))
      .not.toBe(reBillDocKey({ ...base, billingMonth: new Date("2026-08-01T00:00:00.000Z"), docType: "invoice" }));
  });

  it("tolerates null partyId / listingId / billingMonth without collapsing them together", () => {
    const allNull = reBillDocKey({ counterpartyType: "owner", partyId: null, listingId: null, billingMonth: null, docType: "invoice" });
    expect(allNull).toContain("∅");
    expect(allNull).not.toBe(reBillDocKey({ ...base, docType: "invoice" }));
  });
});
