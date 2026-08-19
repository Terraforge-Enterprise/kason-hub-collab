import { describe, it, expect } from "vitest";
import { ownerFundingRequestInput } from "./owner-funding-request";

describe("ownerFundingRequestInput schema (P7)", () => {
  const base = {
    ownerPartyId: "11111111-1111-4111-8111-111111111111",
    amount: "5000.00",
    reason: "Roof repair far exceeds this month's rent collected",
  };

  it("accepts a valid request", () => {
    expect(ownerFundingRequestInput.safeParse(base).success).toBe(true);
  });

  it("accepts an optional propertyId", () => {
    const withProperty = { ...base, propertyId: "22222222-2222-4222-8222-222222222222" };
    expect(ownerFundingRequestInput.safeParse(withProperty).success).toBe(true);
  });

  it("rejects a missing reason", () => {
    const bad = { ownerPartyId: base.ownerPartyId, amount: base.amount };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty reason", () => {
    const bad = { ...base, reason: "" };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });

  it("rejects a reason longer than 500 chars", () => {
    const bad = { ...base, reason: "x".repeat(501) };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });

  it("accepts a reason exactly 500 chars", () => {
    const ok = { ...base, reason: "x".repeat(500) };
    expect(ownerFundingRequestInput.safeParse(ok).success).toBe(true);
  });

  it("accepts a whole-number amount or a single-decimal amount (regex allows 1-2dp)", () => {
    // Mirrors supplier-expense.ts's `money` regex exactly (task-mandated reuse):
    // `\d{1,10}(\.\d{1,2})?` — a bare integer or a 1-2dp decimal, both valid.
    expect(ownerFundingRequestInput.safeParse({ ...base, amount: "5000" }).success).toBe(true);
    expect(ownerFundingRequestInput.safeParse({ ...base, amount: "5000.1" }).success).toBe(true);
  });

  it("rejects a malformed amount (not a 1-2dp money string)", () => {
    for (const bad of ["5000.123", "-5000.00", "abc", ""]) {
      expect(ownerFundingRequestInput.safeParse({ ...base, amount: bad }).success).toBe(false);
    }
  });

  it("rejects an amount beyond DECIMAL(12,2) (>10 integer digits) — clean 400, not a DB 500", () => {
    const bad = { ...base, amount: "99999999999.99" };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });

  it("accepts an amount at the DECIMAL(12,2) boundary (10 integer digits)", () => {
    const ok = { ...base, amount: "9999999999.99" };
    expect(ownerFundingRequestInput.safeParse(ok).success).toBe(true);
  });

  it("rejects a non-uuid ownerPartyId", () => {
    const bad = { ...base, ownerPartyId: "not-a-uuid" };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-uuid propertyId when provided", () => {
    const bad = { ...base, propertyId: "not-a-uuid" };
    expect(ownerFundingRequestInput.safeParse(bad).success).toBe(false);
  });
});
