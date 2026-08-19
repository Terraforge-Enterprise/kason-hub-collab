import { describe, it, expect } from "vitest";
import { summarizeStatement } from "./owner-statement-totals";

describe("summarizeStatement", () => {
  it("contract: collected 2000, fee 200+16 SST + cleaning 100 + tnb 200 + water 20 → deductions 536, net 1464, SST 16", () => {
    const r = summarizeStatement({
      collectedRent: "2000.00",
      lines: [
        { chargeType: "management_fee", amount: "200.00", sstAmount: "16.00" },
        { chargeType: "cleaning", amount: "100.00", sstAmount: "0.00" },
        { chargeType: "tnb", amount: "200.00", sstAmount: "0.00" },
        { chargeType: "water", amount: "20.00", sstAmount: "0.00" },
      ],
    });
    expect(r.totalDeductions).toBe("536.00");
    expect(r.netRemittance).toBe("1464.00");
    expect(r.sstTotal).toBe("16.00");
  });

  it("no lines → zero deductions, net equals collected rent, zero SST", () => {
    const r = summarizeStatement({ collectedRent: "1500.00", lines: [] });
    expect(r.totalDeductions).toBe("0.00");
    expect(r.netRemittance).toBe("1500.00");
    expect(r.sstTotal).toBe("0.00");
  });

  it("net remittance may be negative when deductions exceed collected rent", () => {
    const r = summarizeStatement({
      collectedRent: "100.00",
      lines: [
        { chargeType: "maintenance", amount: "150.00", sstAmount: "0.00" },
        { chargeType: "management_fee", amount: "10.00", sstAmount: "0.80" },
      ],
    });
    expect(r.totalDeductions).toBe("160.80");
    expect(r.netRemittance).toBe("-60.80");
    expect(r.sstTotal).toBe("0.80");
  });

  it("sums SST across multiple SST-bearing lines (no hardcoded single-line assumption)", () => {
    const r = summarizeStatement({
      collectedRent: "2000.00",
      lines: [
        { chargeType: "management_fee", amount: "200.00", sstAmount: "16.00" },
        { chargeType: "insurance", amount: "50.00", sstAmount: "4.00" },
      ],
    });
    expect(r.totalDeductions).toBe("270.00");
    expect(r.netRemittance).toBe("1730.00");
    expect(r.sstTotal).toBe("20.00");
  });

  it("accumulates in cents so fractional cents do not drift (0.10 × repeated)", () => {
    const r = summarizeStatement({
      collectedRent: "1.00",
      lines: Array.from({ length: 3 }, () => ({
        chargeType: "misc",
        amount: "0.10",
        sstAmount: "0.00",
      })),
    });
    expect(r.totalDeductions).toBe("0.30");
    expect(r.netRemittance).toBe("0.70");
    expect(r.sstTotal).toBe("0.00");
  });
});
