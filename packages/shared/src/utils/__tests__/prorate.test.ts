import { describe, expect, it } from "vitest";
import { prorateAmount } from "../prorate";

describe("prorateAmount", () => {
  it("worked example (M3 spec): RM1500, move-in 16 Jun, 30-day June → RM750, 15/30", () => {
    const r = prorateAmount("1500.00", new Date("2026-06-16"), new Date("2026-06-30"), new Date("2026-06-01"));
    expect(r).toEqual({ amount: "750.00", billableDays: 15, daysInMonth: 30 });
  });

  it("full month → full amount", () => {
    const r = prorateAmount(1500, new Date("2026-06-01"), new Date("2026-06-30"), new Date("2026-06-15"));
    expect(r).toEqual({ amount: "1500.00", billableDays: 30, daysInMonth: 30 });
  });

  it("period spanning beyond the anchor month is clamped to it", () => {
    const r = prorateAmount("1500.00", new Date("2026-05-20"), new Date("2026-07-10"), new Date("2026-06-01"));
    expect(r).toEqual({ amount: "1500.00", billableDays: 30, daysInMonth: 30 });
  });

  it("leap February", () => {
    const r = prorateAmount("2900.00", new Date("2024-02-01"), new Date("2024-02-15"), new Date("2024-02-01"));
    expect(r).toEqual({ amount: "1500.00", billableDays: 15, daysInMonth: 29 });
  });

  it("deterministic cent rounding (1000 × 10/31 = 322.5806… → 322.58)", () => {
    const r = prorateAmount("1000.00", new Date("2026-07-01"), new Date("2026-07-10"), new Date("2026-07-01"));
    expect(r.amount).toBe("322.58");
  });

  it("zero overlap → 0.00", () => {
    const r = prorateAmount("1500.00", new Date("2026-08-01"), new Date("2026-08-31"), new Date("2026-06-01"));
    expect(r).toEqual({ amount: "0.00", billableDays: 0, daysInMonth: 30 });
  });

  it("rejects more than 2 decimal places", () => {
    expect(() => prorateAmount("1500.005", new Date("2026-06-01"), new Date("2026-06-30"), new Date("2026-06-01"))).toThrow();
  });

  it("rejects inverted periods", () => {
    expect(() => prorateAmount("1500.00", new Date("2026-06-20"), new Date("2026-06-10"), new Date("2026-06-01"))).toThrow();
  });
});
