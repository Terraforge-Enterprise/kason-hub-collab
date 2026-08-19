import { describe, expect, it } from "vitest";
import type { GroupedGridInvoiceResult } from "../issue-grouped";

/**
 * Owner-document cardinality (R7).
 *
 * Before OEA an owner could only ever hold ONE document per Bill, so issue-grouped.ts
 * modelled the result with a scalar `ownerInvoiceId` and assigned it with
 * `result.ownerInvoiceId = doc.id` — last-write-wins. OEA breaks that assumption: an
 * owner can now hold an IVOWN receivable (profit-natured charges) AND an OEA advice
 * (expense-natured charges) for the same unit and month, so the scalar would silently
 * drop whichever document was issued first.
 */
describe("GroupedGridInvoiceResult owner cardinality", () => {
  it("models owner documents as an array that preserves every id", () => {
    const result: GroupedGridInvoiceResult = { tenantInvoiceIds: [], ownerInvoiceIds: [] };
    result.ownerInvoiceIds.push("doc-ivown");
    result.ownerInvoiceIds.push("doc-oea");
    expect(result.ownerInvoiceIds).toEqual(["doc-ivown", "doc-oea"]);
  });

  it("represents 'no owner document' as an empty array, never null", () => {
    const result: GroupedGridInvoiceResult = { tenantInvoiceIds: [], ownerInvoiceIds: [] };
    expect(result.ownerInvoiceIds).toEqual([]);
  });
});
