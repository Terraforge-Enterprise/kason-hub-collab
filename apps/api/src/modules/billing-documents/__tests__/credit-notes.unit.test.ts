import { describe, it, expect } from "vitest";
import { computeCollectedPortion } from "../credit-notes.service";

describe("computeCollectedPortion", () => {
  it("RM100 charge with RM40 paid (outstanding 60) → collected 40.00", () => {
    expect(computeCollectedPortion("100.00", "60.00")).toBe("40.00");
  });
  it("unpaid charge → 0.00", () => {
    expect(computeCollectedPortion("100.00", "100.00")).toBe("0.00");
  });
  it("fully paid charge → full amount", () => {
    expect(computeCollectedPortion("100.00", "0.00")).toBe("100.00");
  });
  it("never negative (defensive against over-allocated rows)", () => {
    expect(computeCollectedPortion("100.00", "120.00")).toBe("0.00");
  });
  it("integer-cent math, no float drift", () => {
    expect(computeCollectedPortion("0.30", "0.10")).toBe("0.20");
  });
});
