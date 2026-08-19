import { describe, it, expect } from "vitest";
import { selectCorrectionEffect } from "../correction-strategy";

describe("selectCorrectionEffect", () => {
  it("CREDIT_ADJUSTMENT keeps the allocation, no refund/replacement", () => {
    expect(selectCorrectionEffect("CREDIT_ADJUSTMENT", true)).toEqual({
      keepsAllocation: true,
      requiresRefund: false,
      requiresReplacement: false,
    });
  });

  it("DEBIT_ADJUSTMENT keeps the allocation", () => {
    expect(selectCorrectionEffect("DEBIT_ADJUSTMENT", true).keepsAllocation).toBe(true);
  });

  it("CANCEL_AND_REPLACE requires a replacement, moves the allocation", () => {
    expect(selectCorrectionEffect("CANCEL_AND_REPLACE", true)).toEqual({
      keepsAllocation: false,
      requiresRefund: false,
      requiresReplacement: true,
    });
  });

  it("REFUND requires refund details", () => {
    expect(selectCorrectionEffect("REFUND", true).requiresRefund).toBe(true);
  });
});
