import { describe, expect, it } from "vitest";
import { isBeyondAdvanceBillingWindow } from "../billing-month";

describe("advance billing window", () => {
  const current = new Date("2026-08-01T00:00:00.000Z");

  it("allows the current and immediately following month", () => {
    expect(isBeyondAdvanceBillingWindow(new Date("2026-08-01T00:00:00.000Z"), current)).toBe(false);
    expect(isBeyondAdvanceBillingWindow(new Date("2026-09-01T00:00:00.000Z"), current)).toBe(false);
  });

  it("blocks the second future month and anything after it", () => {
    expect(isBeyondAdvanceBillingWindow(new Date("2026-10-01T00:00:00.000Z"), current)).toBe(true);
    expect(isBeyondAdvanceBillingWindow(new Date("2027-01-01T00:00:00.000Z"), current)).toBe(true);
  });

  it("handles the December to January boundary", () => {
    const december = new Date("2026-12-01T00:00:00.000Z");
    expect(isBeyondAdvanceBillingWindow(new Date("2027-01-01T00:00:00.000Z"), december)).toBe(false);
    expect(isBeyondAdvanceBillingWindow(new Date("2027-02-01T00:00:00.000Z"), december)).toBe(true);
  });
});
