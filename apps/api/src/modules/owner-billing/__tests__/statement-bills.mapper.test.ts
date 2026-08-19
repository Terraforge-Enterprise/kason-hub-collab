import { describe, it, expect } from "vitest";
import { gridBillGroupKey } from "../statement-bills";

describe("gridBillGroupKey", () => {
  it("maps ledgerCategory through verbatim", () => {
    expect(gridBillGroupKey("utilities_tnb")).toBe("utilities_tnb");
  });
  it("null falls to bill_grid", () => {
    expect(gridBillGroupKey(null)).toBe("bill_grid");
    expect(gridBillGroupKey(undefined)).toBe("bill_grid");
  });
  it("blank falls to bill_grid", () => {
    expect(gridBillGroupKey("   ")).toBe("bill_grid");
  });
});
