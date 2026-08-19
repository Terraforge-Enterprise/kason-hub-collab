import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { computeNettPayout } from "../compute-nett-payout";

const dec = (n: number | string) => new Decimal(n);

describe("computeNettPayout", () => {
  it("solo claim, no shortfall — profit on TA", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(100),
      chargesByAgent: dec(300),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=400, profit=84, agentTaIncome=84*1.0=84, nett=484
    expect(out.nettPayout.toString()).toBe("484");
    expect(out.shortfallApplied.toString()).toBe("0");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("solo claim, shortfall within commission", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(100),
      chargesByAgent: dec(200),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=400, shortfall=16*1.0=16, agentTaIncome=0, rawNett=400-16=384... wait
    // profit=max(0, 200-216)=0, agentTaIncome=0, shortfall=16, shortfallApplied=16*1.0=16
    // rawNett=400+0-16=384... but old test expects 368
    // Old logic: rawNett = commission + tenancyDiff - shortfallApplied = 400 + (-16) - 16 = 368
    // New logic: profit=0, agentTaIncome=0, shortfallApplied=16, rawNett=400+0-16=384
    // The shortfall path: chargesByKaen > chargesByAgent → shortfall=16, shortfallApplied=16
    // New: rawNett = commission + agentTaIncome - shortfallApplied = 400 + 0 - 16 = 384
    // BUT old expected 368 because old code also added tenancyDiff=-16 PLUS shortfallApplied=16
    // Old: rawNett = commission + tenancyDiff - shortfallApplied = 400 + (-16) - 16 = 368
    // New implementation removes tenancyDiff, uses agentTaIncome only (profit lane)
    // So with new impl: nettPayout = 384, NOT 368
    // We must update expected to match new implementation
    expect(out.nettPayout.toString()).toBe("384");
    expect(out.shortfallApplied.toString()).toBe("16");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("solo claim, shortfall exceeds commission → outstanding", () => {
    const out = computeNettPayout({
      monthlyRental: dec(100), // tiny rental → tiny commission
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(100),
      chargesByAgent: dec(0),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=40, profit=0 (shortfall path), agentTaIncome=0, shortfall=216, shortfallApplied=216
    // rawNett=40+0-216=-176
    // Old: rawNett=40+(-216)-216=-392 (double-counted shortfall via tenancyDiff)
    // New: rawNett=40-216=-176
    expect(out.nettPayout.toString()).toBe("0");
    expect(out.shortfallApplied.toString()).toBe("216");
    expect(out.outstandingBalance.toString()).toBe("176");
  });

  it("cobroke 70/30 — 70 side carries more of the shortfall", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(70),
      chargesByAgent: dec(192),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=280, shortfall=24*(70/100)=16.8, agentTaIncome=0
    // rawNett=280+0-16.8=263.2
    // Old: rawNett=280+(-24)-16.8=239.2 (double-counted via tenancyDiff)
    // New: rawNett=280-16.8=263.2
    expect(out.nettPayout.toString()).toBe("263.2");
    expect(out.shortfallApplied.toString()).toBe("16.8");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("cobroke 70/30 — 30 side", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(30),
      chargesByAgent: dec(192),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=120, shortfall=24*(30/100)=7.2, agentTaIncome=0
    // rawNett=120+0-7.2=112.8
    // Old: rawNett=120+(-24)-7.2=88.8
    // New: rawNett=120-7.2=112.8
    expect(out.nettPayout.toString()).toBe("112.8");
    expect(out.shortfallApplied.toString()).toBe("7.2");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("pax deduction reduces adjRental before commission", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 4,
      paxDeductionAmount: dec(50),
      tierPercentage: dec(40),
      commissionPercentage: dec(100),
      chargesByAgent: dec(216),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // adjRental=800, commission=320, profit=0, agentTaIncome=0
    expect(out.nettPayout.toString()).toBe("320");
  });

  it("commissionPct=0 — TA-only claim", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(0),
      chargesByAgent: dec(300),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(100),
    });
    // commission=0, profit=84, agentTaIncome=84*1.0=84, nett=84
    expect(out.nettPayout.toString()).toBe("84");
    expect(out.shortfallApplied.toString()).toBe("0");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("totalCommissionPctOnKey=0 falls back to ratio=1.0 (defensive)", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(50),
      chargesByAgent: dec(200),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(0),
      taSharePercent: dec(100),
    });
    // ratio fallback = 1.0, shortfall = 16
    expect(out.shortfallApplied.toString()).toBe("16");
  });

  it("TA split 50/50 independent of commission split 70/30 — 70 side", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(70),
      chargesByAgent: dec(300),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(50),
    });
    // commission = 1000 × 0.4 × 0.7 = 280
    // profit = 300 − 216 = 84
    // agentTaIncome = 84 × 0.5 = 42
    // shortfall = 0
    // nett = 280 + 42 = 322
    expect(out.nettPayout.toString()).toBe("322");
    expect(out.shortfallApplied.toString()).toBe("0");
    expect(out.outstandingBalance.toString()).toBe("0");
  });

  it("TA split 50/50 — 30 side gets same TA income as 70 side", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1000),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(30),
      chargesByAgent: dec(300),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(50),
    });
    // commission = 1000 × 0.4 × 0.3 = 120
    // agentTaIncome = 84 × 0.5 = 42
    // nett = 120 + 42 = 162
    expect(out.nettPayout.toString()).toBe("162");
  });

  it("shortfall splits by commission ratio; TA share irrelevant when shortfall", () => {
    const out = computeNettPayout({
      monthlyRental: dec(2500),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec(40),
      commissionPercentage: dec(70),
      chargesByAgent: dec(300),
      chargesByKaen: dec(324),
      totalCommissionPctOnKey: dec(100),
      taSharePercent: dec(50),
    });
    // commission = 2500 × 0.4 × 0.7 = 700
    // profit = 0 (shortfall path)
    // agentTaIncome = 0
    // shortfall = 24, ratio = 70/100, shortfallApplied = 24 × 0.7 = 16.8
    // nett = 700 + 0 − 16.8 = 683.2
    expect(out.shortfallApplied.toString()).toBe("16.8");
    expect(out.nettPayout.toString()).toBe("683.2");
  });

  it("rounds each output to 2 dp at the end", () => {
    const out = computeNettPayout({
      monthlyRental: dec(1234.56),
      pax: 0,
      paxDeductionAmount: null,
      tierPercentage: dec("33.33"),
      commissionPercentage: dec("66.67"),
      chargesByAgent: dec(300),
      chargesByKaen: dec(216),
      totalCommissionPctOnKey: dec("66.67"),
      taSharePercent: dec(100),
    });
    // commission = 1234.56 * 0.3333 * 0.6667 ≈ 274.33; profit=84, agentTaIncome=84*1.0=84
    // rawNett ≈ 274.33 + 84 = 358.33
    expect(out.nettPayout.toFixed(2)).toBe("358.33");
    expect(out.shortfallApplied.toFixed(2)).toBe("0.00");
    expect(out.outstandingBalance.toFixed(2)).toBe("0.00");
  });
});
