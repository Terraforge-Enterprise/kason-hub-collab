import { describe, it, expect } from "vitest";
import { isCommissionMonth, monthlyChargeType, resolveCommissionMonth } from "../commission-month";

// Tenancy dates + billing months are UTC-midnight; the resolver keys on getUTC*.
const d = (s: string) => new Date(s + "T00:00:00.000Z");
const on = { firstMonthIsCommission: true };
const off = { firstMonthIsCommission: false };

describe("resolveCommissionMonth", () => {
  it("mid-month move-in → the NEXT month is the first full month", () => {
    expect(resolveCommissionMonth(d("2025-12-24"), d("2026-08-30"))).toEqual({ year: 2026, month0: 0 }); // Jan
  });
  it("B11: move-in on the 1st → THAT month is the first full month", () => {
    expect(resolveCommissionMonth(d("2026-08-01"), null)).toEqual({ year: 2026, month0: 7 }); // Aug
  });
  it("M-E5 year-wrap: mid-December move-in → commission is the NEXT year's January", () => {
    expect(resolveCommissionMonth(d("2026-12-15"), d("2027-12-14"))).toEqual({ year: 2027, month0: 0 });
  });
  it("B15: tenancy with no full calendar month → null", () => {
    expect(resolveCommissionMonth(d("2026-08-15"), d("2026-09-20"))).toBeNull();
  });
  it("M-E2 boundary: endDate EXACTLY the candidate month's last day → commission stands (< not <=)", () => {
    expect(resolveCommissionMonth(d("2026-08-01"), d("2026-08-31"))).toEqual({ year: 2026, month0: 7 });
  });
  it("M-E2b boundary: endDate one day before the last day → not full → null", () => {
    expect(resolveCommissionMonth(d("2026-08-01"), d("2026-08-30"))).toBeNull();
  });
  it("M-E3: keys on UTC date — a UTC-midnight 1st resolves as on-the-first", () => {
    expect(resolveCommissionMonth(d("2026-08-01"), null)).toEqual({ year: 2026, month0: 7 });
  });
  it("open-ended tenancy (endDate null) → first full month always resolves", () => {
    expect(resolveCommissionMonth(d("2025-12-24"), null)).toEqual({ year: 2026, month0: 0 });
  });
  it("invalid dates → null (defense-in-depth, matches the preview)", () => {
    expect(resolveCommissionMonth(new Date("garbage"), null)).toBeNull();
    expect(resolveCommissionMonth(d("2026-08-01"), new Date("garbage"))).toBeNull();
  });
});

describe("isCommissionMonth", () => {
  const t = { startDate: d("2025-12-24"), endDate: d("2026-08-30"), ...on };

  it("B10: the first full month (Jan) is the commission month", () => {
    expect(isCommissionMonth(t, d("2026-01-01"))).toBe(true);
  });
  it("B12: the prorated move-in month (Dec) is NOT commission → ordinary owner rent", () => {
    expect(isCommissionMonth(t, d("2025-12-01"))).toBe(false);
  });
  it("B13: exactly ONE commission month — Feb and every later month are NOT commission", () => {
    expect(isCommissionMonth(t, d("2026-02-01"))).toBe(false);
    expect(isCommissionMonth(t, d("2026-03-01"))).toBe(false);
    expect(isCommissionMonth(t, d("2026-08-01"))).toBe(false);
  });
  it("B11: move-in on the 1st → month 1 IS commission, month 2 is not (no double-commission)", () => {
    const t1 = { startDate: d("2026-08-01"), endDate: null, ...on };
    expect(isCommissionMonth(t1, d("2026-08-01"))).toBe(true);
    expect(isCommissionMonth(t1, d("2026-09-01"))).toBe(false);
  });
  it("B14: firstMonthIsCommission=false → NEVER commission (even the first full month)", () => {
    expect(isCommissionMonth({ ...t, ...off }, d("2026-01-01"))).toBe(false);
  });
  it("B15: no full month → never commission", () => {
    const short = { startDate: d("2026-08-15"), endDate: d("2026-09-20"), ...on };
    expect(isCommissionMonth(short, d("2026-09-01"))).toBe(false);
  });
});

describe("monthlyChargeType (poster/auto-draft decision: rent vs letting_commission)", () => {
  const t = { startDate: d("2025-12-24"), endDate: d("2026-08-30"), ...on };

  it("B16: the commission month + flag ON → 'letting_commission' (→ IVTEN)", () => {
    expect(monthlyChargeType(t, d("2026-01-01"), true)).toBe("letting_commission");
  });
  it("B17: every non-commission month → 'rent' (prorated move-in month AND later months)", () => {
    expect(monthlyChargeType(t, d("2025-12-01"), true)).toBe("rent");
    expect(monthlyChargeType(t, d("2026-02-01"), true)).toBe("rent");
    expect(monthlyChargeType(t, d("2026-08-01"), true)).toBe("rent");
  });
  it("B41: flag OFF → ALWAYS 'rent' (byte-identical to today, even on the commission month)", () => {
    expect(monthlyChargeType(t, d("2026-01-01"), false)).toBe("rent");
  });
  it("firstMonthIsCommission=false → always 'rent' even with the flag on", () => {
    expect(monthlyChargeType({ ...t, firstMonthIsCommission: false }, d("2026-01-01"), true)).toBe("rent");
  });
});
