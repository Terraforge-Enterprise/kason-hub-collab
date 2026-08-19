import { describe, expect, it } from "vitest";
import {
  computeSalesCommissionAmount,
  validateSalesSplitsHundredPercent,
} from "../sales-claims.validators";

describe("validateSalesSplitsHundredPercent", () => {
  it("rejects empty splits array", () => {
    const r = validateSalesSplitsHundredPercent([], 25000);
    expect(r.ok).toBe(false);
  });

  it("happy: 60/15/25 percent splits sum exactly to commission amount", () => {
    const r = validateSalesSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 60 },
        { splitType: "percent", splitValue: 15 },
        { splitType: "percent", splitValue: 25 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: percent-only with non-round commission amount", () => {
    const r = validateSalesSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 50 },
        { splitType: "percent", splitValue: 50 },
      ],
      45000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: fixed-only splits sum to amount", () => {
    const r = validateSalesSplitsHundredPercent(
      [
        { splitType: "fixed", splitValue: 15000 },
        { splitType: "fixed", splitValue: 10000 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: mixed percent + fixed sums correctly", () => {
    // 50% of 25000 = 12500, plus fixed 12500 = 25000.
    const r = validateSalesSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 50 },
        { splitType: "fixed", splitValue: 12500 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts ±RM 0.01 boundary (under)", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 24999.99 }],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts ±RM 0.01 boundary (over)", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 25000.01 }],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects RM 0.02 over", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 25000.02 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects RM 0.02 under", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 24999.98 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when total grossly off", () => {
    const r = validateSalesSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 60 },
        { splitType: "percent", splitValue: 30 },
      ],
      25000,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sum/i);
  });

  it("rejects non-finite computed amount", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "percent", splitValue: 100 }],
      Number.NaN,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects negative split value", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: -1 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown split type", () => {
    const r = validateSalesSplitsHundredPercent(
      [{ splitType: "weird" as unknown as "fixed", splitValue: 25000 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });
});

describe("computeSalesCommissionAmount", () => {
  it("percent_of_purchase: 1,000,000 × 2.5% = 25,000", () => {
    expect(computeSalesCommissionAmount("percent_of_purchase", 2.5, 1_000_000)).toBe(
      25_000,
    );
  });

  it("fixed: 30,000 → 30,000 regardless of purchasePrice", () => {
    expect(computeSalesCommissionAmount("fixed", 30_000, 1_000_000)).toBe(30_000);
    expect(computeSalesCommissionAmount("fixed", 30_000, 0)).toBe(30_000);
  });

  it("percent_of_purchase: rounds to 2dp", () => {
    // 333,333 × 3.33% = 11,099.9889 → rounds to 11,099.99
    expect(computeSalesCommissionAmount("percent_of_purchase", 3.33, 333_333)).toBe(
      11_099.99,
    );
  });

  it("returns 0 on invalid commissionValue", () => {
    expect(computeSalesCommissionAmount("fixed", Number.NaN, 1_000_000)).toBe(0);
    expect(computeSalesCommissionAmount("percent_of_purchase", -1, 1_000_000)).toBe(0);
  });

  it("returns 0 on invalid purchasePrice", () => {
    expect(computeSalesCommissionAmount("percent_of_purchase", 2, Number.NaN)).toBe(0);
    expect(computeSalesCommissionAmount("percent_of_purchase", 2, -1)).toBe(0);
  });
});
