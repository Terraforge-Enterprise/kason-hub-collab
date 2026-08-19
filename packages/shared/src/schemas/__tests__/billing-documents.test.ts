import { describe, it, expect } from "vitest";
import { listBillingDocumentsQuery, BILLING_DOCUMENT_STATUSES } from "../billing-documents";

describe("listBillingDocumentsQuery", () => {
  it("applies paging defaults and accepts all filters", () => {
    const parsed = listBillingDocumentsQuery.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(25);

    const full = listBillingDocumentsQuery.parse({
      docType: "debit_note",
      seriesId: "11111111-1111-4111-8111-111111111111",
      partyId: "22222222-2222-4222-8222-222222222222",
      apartmentId: "33333333-3333-4333-8333-333333333333",
      month: "2026-07",
      status: "partially_settled",
      q: "DEP-00",
      page: "2",
      pageSize: "50",
    });
    expect(full.page).toBe(2);
    expect(full.pageSize).toBe(50);
    expect(full.docType).toBe("debit_note");
  });

  it("rejects a malformed month and an unknown status", () => {
    expect(listBillingDocumentsQuery.safeParse({ month: "July 2026" }).success).toBe(false);
    expect(listBillingDocumentsQuery.safeParse({ status: "paid" }).success).toBe(false);
  });

  it("status vocabulary is the 4-state document lifecycle", () => {
    expect(BILLING_DOCUMENT_STATUSES).toEqual(["issued", "partially_settled", "settled", "offset"]);
  });
});
