import { describe, it, expect } from "vitest";
import { createMeterSchema, createReadingSchema, createUtilityBillSchema, utilityBillingConfigSchema } from "../../index";

describe("meter schemas", () => {
  it("accepts a valid meter config", () => {
    const r = createMeterSchema.safeParse({ unitId: "11111111-1111-4111-8111-111111111111", ratePerKwh: "0.60" });
    expect(r.success).toBe(true);
  });
  it("rejects a negative reading", () => {
    const r = createReadingSchema.safeParse({ unitId: "11111111-1111-4111-8111-111111111111", periodMonth: "2026-06-01", currentReading: "-5" });
    expect(r.success).toBe(false);
  });
});

describe("utility bill schema", () => {
  it("accepts a bill with wifi and no method/kwh", () => {
    const r = createUtilityBillSchema.safeParse({
      apartmentId: "11111111-1111-4111-8111-111111111111",
      periodMonth: "2026-06-01", tnbTotal: "134.40", airSelangor: "6.50", wifi: "89.00",
    });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown method field is irrelevant (method removed) — still parses", () => {
    const r = createUtilityBillSchema.safeParse({
      apartmentId: "11111111-1111-4111-8111-111111111111", periodMonth: "2026-06-01", tnbTotal: "10",
    });
    expect(r.success).toBe(true);
  });
});

describe("utility billing config schema", () => {
  it("accepts subsidyPerPax", () => {
    expect(utilityBillingConfigSchema.safeParse({ subsidyPerPax: "50.00" }).success).toBe(true);
  });
});
