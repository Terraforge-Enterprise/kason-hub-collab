import { describe, it, expect } from "vitest";
import {
  OWNER_LEDGER_CATEGORIES, OWNER_PAID_BY, ownerLedgerEntryInput, ownerLedgerEntryPatch,
} from "../owner-ledger";

// NOTE: Zod v4's .uuid() enforces RFC v4 bit pattern (third group starts "4",
// fourth group starts "8"-"b").  The brief uses illustrative "11111111-..." strings
// which are not valid v4 UUIDs and would fail for the wrong reason.
// We use the codebase's canonical valid-v4 fixture (same convention as owner-billing.test.ts).
const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000002";

describe("owner-ledger schemas", () => {
  it("exposes the 5 paid-by values and income+expense categories", () => {
    expect(OWNER_PAID_BY).toEqual(["kaen", "owner", "tenant", "developer", "other"]);
    expect(OWNER_LEDGER_CATEGORIES).toContain("rental_income");
    expect(OWNER_LEDGER_CATEGORIES).toContain("assessment");
    expect(OWNER_LEDGER_CATEGORIES).toContain("cukai_petak");
  });
  it("accepts a valid expense entry and rejects a bad amount / unknown category", () => {
    const ok = ownerLedgerEntryInput.safeParse({
      ownerPartyId: OWNER_ID,
      propertyId: PROPERTY_ID,
      statementMonth: "2026-07", transactionDate: "2026-07-05",
      direction: "expense", category: "maintenance_fee", amount: "350.00",
      paidBy: "kaen", paymentStatus: "paid", taxCategory: "rental_expense",
    });
    expect(ok.success).toBe(true);
    if (!ok.success) throw new Error("expected the valid expense entry to parse");
    expect(ownerLedgerEntryInput.safeParse({ ...ok.data, amount: "-5" }).success).toBe(false);
    expect(ownerLedgerEntryInput.safeParse({ ...ok.data, category: "nope" }).success).toBe(false);
  });
  it("PATCH requires expectedUpdatedAt + at least one mutable field", () => {
    expect(ownerLedgerEntryPatch.safeParse({ expectedUpdatedAt: "2026-07-05T00:00:00.000Z" }).success).toBe(false);
    expect(ownerLedgerEntryPatch.safeParse({ amount: "20.00", expectedUpdatedAt: "2026-07-05T00:00:00.000Z" }).success).toBe(true);
  });
  it('accepts direction:"payout" on CREATE when category=owner_payout + paidBy=kaen (§10 un-deferred)', () => {
    const base = {
      ownerPartyId: OWNER_ID, propertyId: PROPERTY_ID,
      statementMonth: "2026-07", transactionDate: "2026-07-05",
      amount: "350.00", paidBy: "kaen", paymentStatus: "paid", taxCategory: "not_applicable",
    };
    // Valid payout: direction=payout, category=owner_payout, paidBy=kaen
    expect(ownerLedgerEntryInput.safeParse({ ...base, direction: "payout", category: "owner_payout" }).success).toBe(true);
    // Bad payout: wrong category
    expect(ownerLedgerEntryInput.safeParse({ ...base, direction: "payout", category: "management_fee" }).success).toBe(false);
    // Bad payout: wrong paidBy
    expect(ownerLedgerEntryInput.safeParse({ ...base, direction: "payout", category: "owner_payout", paidBy: "owner" }).success).toBe(false);
    // Normal entries still work
    expect(ownerLedgerEntryInput.safeParse({ ...base, direction: "income", category: "rental_income", taxCategory: "rental_expense" }).success).toBe(true);
    expect(ownerLedgerEntryInput.safeParse({ ...base, direction: "expense", category: "management_fee", taxCategory: "rental_expense" }).success).toBe(true);
  });
  it('rejects statementMonth:"YYYY-MM-DD" and accepts "YYYY-MM" (contract pin)', () => {
    const base = {
      ownerPartyId: OWNER_ID, propertyId: PROPERTY_ID,
      transactionDate: "2026-06-05",
      direction: "expense", category: "maintenance_fee", amount: "100.00",
      paidBy: "kaen", paymentStatus: "paid", taxCategory: "rental_expense",
    };
    // Full ISO date must be REJECTED — this was the 400-causing bug
    expect(ownerLedgerEntryInput.safeParse({ ...base, statementMonth: "2026-06-01" }).success).toBe(false);
    // YYYY-MM must succeed
    expect(ownerLedgerEntryInput.safeParse({ ...base, statementMonth: "2026-06" }).success).toBe(true);
  });
  it('accepts direction:"payout" on PATCH when shape is valid (§10 un-deferred)', () => {
    const ISO = "2026-07-05T00:00:00.000Z";
    // payout with matching category + paidBy → valid
    expect(ownerLedgerEntryPatch.safeParse({ direction: "payout", category: "owner_payout", paidBy: "kaen", expectedUpdatedAt: ISO }).success).toBe(true);
    // payout with wrong category → invalid
    expect(ownerLedgerEntryPatch.safeParse({ direction: "payout", category: "management_fee", expectedUpdatedAt: ISO }).success).toBe(false);
    // normal expense patch still works
    expect(ownerLedgerEntryPatch.safeParse({ direction: "expense", expectedUpdatedAt: ISO }).success).toBe(true);
  });
});
