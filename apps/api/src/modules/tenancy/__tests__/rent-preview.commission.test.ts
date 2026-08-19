import { describe, it, expect } from "vitest";
import { computeFirstMonthCommission } from "../rent-preview";

const d = (s: string) => new Date(s + "T00:00:00.000Z");

describe("computeFirstMonthCommission", () => {
  it("1st-of-month start: commission month = start month, flat 8% of full rent", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: d("2026-08-01"), endDate: null, isCommission: true, sstBearer: "owner" });
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ month: "2026-08", commissionAmount: 3000, sstRate: 0.08, sstAmount: 240, total: 3240, sstBearer: "owner" });
  });

  it("mid-month start: commission month = FOLLOWING month, SST on full rent not prorated", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: d("2026-08-15"), endDate: d("2027-08-14"), isCommission: true, sstBearer: "kaen" });
    expect(r).not.toBeNull();
    expect(r?.month).toBe("2026-09");
    expect(r?.commissionAmount).toBe(3000);
    expect(r?.sstAmount).toBe(240);
  });

  it("Dec-15 start wraps to the next January", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: d("2026-12-15"), endDate: d("2027-12-14"), isCommission: true, sstBearer: "owner" });
    expect(r?.month).toBe("2027-01");
  });

  it("no full calendar month → null", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: d("2026-08-15"), endDate: d("2026-09-20"), isCommission: true, sstBearer: "owner" });
    expect(r).toBeNull();
  });

  it("isCommission false → null", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: d("2026-08-01"), endDate: null, isCommission: false, sstBearer: "owner" });
    expect(r).toBeNull();
  });

  it("invalid startDate → null", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: new Date("garbage"), endDate: null, isCommission: true, sstBearer: "owner" });
    expect(r).toBeNull();
  });

  it("valid start + invalid endDate → null", () => {
    const r = computeFirstMonthCommission({ monthlyRent: 3000, startDate: new Date("2026-08-01T00:00:00.000Z"), endDate: new Date("garbage"), isCommission: true, sstBearer: "owner" });
    expect(r).toBeNull();
  });
});
