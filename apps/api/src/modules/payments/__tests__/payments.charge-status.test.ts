import { describe, it, expect } from "vitest";
import { chargeStatusForOutstanding } from "../payments.charge-status";

describe("chargeStatusForOutstanding", () => {
  it("returns paid when fully settled", () => {
    expect(chargeStatusForOutstanding(0, 900)).toBe("paid");
  });
  it("returns partially_paid when some outstanding remains", () => {
    expect(chargeStatusForOutstanding(150, 900)).toBe("partially_paid");
  });
  it("returns posted when fully restored (outstanding === amount)", () => {
    expect(chargeStatusForOutstanding(900, 900)).toBe("posted");
  });
  it("treats sub-cent rounding as paid", () => {
    expect(chargeStatusForOutstanding(0.004, 900)).toBe("paid");
  });
});
