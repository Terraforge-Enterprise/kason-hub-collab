import { describe, it, expect } from "vitest";
import { manualInvoiceInput } from "../schemas/manual-invoice";

const base = {
  counterpartyType: "tenant" as const,
  partyId: "11111111-1111-4111-8111-111111111111",
  billingMonth: "2026-07",
  lines: [{ description: "Manual rent", categoryId: "22222222-2222-4222-8222-222222222222", amount: "100.00" }],
};

describe("manualInvoiceInput", () => {
  it("accepts a well-formed body", () => {
    expect(manualInvoiceInput.safeParse(base).success).toBe(true);
  });
  it("rejects an empty lines array", () => {
    expect(manualInvoiceInput.safeParse({ ...base, lines: [] }).success).toBe(false);
  });
  it("rejects a non-2dp amount", () => {
    expect(manualInvoiceInput.safeParse({ ...base, lines: [{ ...base.lines[0], amount: "100.5" }] }).success).toBe(true);
    expect(manualInvoiceInput.safeParse({ ...base, lines: [{ ...base.lines[0], amount: "abc" }] }).success).toBe(false);
  });
});
