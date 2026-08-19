import { describe, it, expect } from "vitest";
import { createCreditNoteInput } from "../billing-documents";
import { randomUUID } from "node:crypto";

describe("createCreditNoteInput", () => {
  const base = {
    originalDocumentId: randomUUID(),
    partyId: randomUUID(),
    counterpartyType: "tenant" as const,
    lines: [{ description: "Overpayment", amount: "50.00" }],
    reason: "tenant overpaid",
    idempotencyKey: randomUUID(),
  };
  it("accepts a minimal valid body (creditAmount + line charge/category optional)", () => {
    expect(createCreditNoteInput.safeParse(base).success).toBe(true);
  });
  it("rejects a body with no reason", () => {
    const { reason, ...noReason } = base;
    expect(reason).toBeDefined();
    expect(createCreditNoteInput.safeParse(noReason).success).toBe(false);
  });
  it("rejects an empty lines array", () => {
    expect(createCreditNoteInput.safeParse({ ...base, lines: [] }).success).toBe(false);
  });
});
