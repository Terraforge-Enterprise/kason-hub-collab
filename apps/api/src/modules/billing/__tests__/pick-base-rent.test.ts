import { describe, it, expect } from "vitest";
import { pickBaseRent } from "../post-monthly-rent";

describe("pickBaseRent", () => {
  it("reservation agreed rent wins over tenancy monthly rent", () => {
    expect(pickBaseRent(null, 1800, 1500)).toBe(1800);
  });
  it("active RecurringCharge wins over everything", () => {
    expect(pickBaseRent(1200, 1800, 1500)).toBe(1200);
  });
  it("falls back to tenancy monthly rent when no rc and no reservation", () => {
    expect(pickBaseRent(null, null, 1500)).toBe(1500);
  });
  // Adversarial-audit additions (B4-B6): the 3 rows above never exercise "RC set,
  // reservation absent" (B4), nor the `!= null` (not truthy) guard on either nullable
  // branch (B5/B6) — a waived/comp RM0 rent must still win its precedence slot.
  it("RecurringCharge wins even when there is no reservation", () => {
    expect(pickBaseRent(1200, null, 1500)).toBe(1200);
  });
  it("RecurringCharge of exactly 0 still wins (not falsy-skipped)", () => {
    expect(pickBaseRent(0, 1800, 1500)).toBe(0);
  });
  it("reservation agreed rent of exactly 0 still wins over tenancy", () => {
    expect(pickBaseRent(null, 0, 1500)).toBe(0);
  });
});
