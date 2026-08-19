// packages/shared/src/finance/__tests__/owner-pass-through-income.test.ts
//
// Pass-through income: money the TENANT pays for their own utilities, which KAEN
// collects and forwards to the supplier. It is never the owner's money, so it must
// not inflate the payout — but it MUST stay visible on the statement so the owner
// can see what the tenant was charged.
//
// The trigger is deliberately NARROW (see isPassThroughIncomeLine): an income line
// only goes neutral when it is a utility/aircond category AND the sync explicitly
// stamped includeInPayout:false. rental_income / carpark_income / other_income can
// NEVER be neutralised by this rule, whatever their flag — those are the categories
// where a false negative would UNDER-pay a real owner.
import { describe, it, expect } from "vitest";
import {
  summarizeOwnerPeriod,
  computeOwnerRunningBalance,
  isPassThroughIncomeLine,
  type OwnerLedgerLine,
} from "../owner-net-payout";

const L = (p: Partial<OwnerLedgerLine>): OwnerLedgerLine => ({
  direction: "expense", category: "other_expense", amount: "0.00", sstAmount: null,
  includeInPayout: true, taxCategory: "rental_expense", ...p,
});

const rent = (amount: string) =>
  L({ direction: "income", category: "rental_income", amount, includeInPayout: true });
/** Unpaired tenant utility carve-out — the grid path, no supplier-bill counterparty. */
const passThrough = (amount: string, category = "utility_income") =>
  L({ direction: "income", category, amount, includeInPayout: false });
/** Paired tenant carve-out — the legacy meter path, offsets a full-bill expense. */
const pairedCarveOut = (amount: string, category = "utility_income") =>
  L({ direction: "income", category, amount, includeInPayout: true });

describe("isPassThroughIncomeLine", () => {
  it("is true only for utility/aircond income explicitly stamped includeInPayout:false", () => {
    expect(isPassThroughIncomeLine(passThrough("100.00", "utility_income"))).toBe(true);
    expect(isPassThroughIncomeLine(passThrough("100.00", "aircond_income"))).toBe(true);
  });

  it("never neutralises a paired carve-out (includeInPayout:true)", () => {
    expect(isPassThroughIncomeLine(pairedCarveOut("100.00", "utility_income"))).toBe(false);
    expect(isPassThroughIncomeLine(pairedCarveOut("100.00", "aircond_income"))).toBe(false);
  });

  // The regression guard that matters most: deriveIncludeInPayout() stamps
  // includeInPayout = (paidBy === "kaen"), so an admin-entered income row can
  // legitimately carry false. Those categories must stay in the payout or a real
  // owner silently loses money.
  it("never neutralises rental/carpark/other income even when includeInPayout is false", () => {
    for (const category of ["rental_income", "carpark_income", "other_income", "utilities_reimbursement"]) {
      expect(
        isPassThroughIncomeLine(L({ direction: "income", category, amount: "500.00", includeInPayout: false })),
        `${category} must never be treated as pass-through`,
      ).toBe(false);
    }
  });

  it("never treats an expense line as pass-through income", () => {
    expect(isPassThroughIncomeLine(L({ category: "utilities_tnb", amount: "300.00", includeInPayout: false }))).toBe(false);
  });
});

describe("summarizeOwnerPeriod — pass-through income", () => {
  // The reported bug, in miniature: tenant pays 754 of utilities, no supplier-bill
  // expense exists to offset it, so the owner was told to collect 754 that was
  // never theirs.
  it("keeps unpaired tenant utility income out of grossRental and the payout", () => {
    const s = summarizeOwnerPeriod([
      passThrough("300.00"),
      passThrough("100.00"),
      passThrough("134.00"),
      passThrough("100.00"),
      passThrough("120.00"),
    ]);
    expect(s.grossRental).toBe("0.00");
    expect(s.netPayoutToOwner).toBe("0.00");
    // …but the money is still reported, so the statement can show it.
    expect(s.passThroughIncome).toBe("754.00");
  });

  it("reports the owner's real payout: rent less mgmt fee and cleaning, utilities neutral", () => {
    const s = summarizeOwnerPeriod([
      rent("2000.00"),
      passThrough("330.00"),                                              // water + electricity
      passThrough("200.00", "aircond_income"),                            // aircond
      L({ category: "management_fee", amount: "200.00", sstAmount: "16.00" }),
      L({ category: "cleaning", amount: "100.00" }),                      // KAEN profit
    ]);
    expect(s.grossRental).toBe("2000.00");
    expect(s.passThroughIncome).toBe("530.00");
    expect(s.netPayoutToOwner).toBe("1684.00"); // 2000 − 216 − 100
  });

  it("leaves the paired gross model byte-identical (meter path must not regress)", () => {
    // Full supplier bill deducts; the tenant carve-out offsets it. Net owner cost
    // is the difference — the behaviour the gross integration suite pins.
    const s = summarizeOwnerPeriod([
      rent("1000.00"),
      pairedCarveOut("8.46", "aircond_income"),
      L({ category: "utilities_tnb", amount: "188.70" }),
    ]);
    expect(s.grossRental).toBe("1008.46");
    expect(s.passThroughIncome).toBe("0.00");
    expect(s.netPayoutToOwner).toBe("819.76"); // 1008.46 − 188.70
  });

  it("folds SST into the pass-through total rather than the payout", () => {
    const s = summarizeOwnerPeriod([rent("1000.00"), L({
      direction: "income", category: "utility_income", amount: "100.00",
      sstAmount: "8.00", includeInPayout: false,
    })]);
    expect(s.grossRental).toBe("1000.00");
    expect(s.passThroughIncome).toBe("108.00");
  });
});

describe("computeOwnerRunningBalance — pass-through income", () => {
  // The balance is what KAEN actually remits. If it disagreed with the statement's
  // payout the owner would be paid a different number than the document shows.
  it("does not add unpaired tenant utility income to the owner's balance", () => {
    expect(computeOwnerRunningBalance([rent("2000.00"), passThrough("754.00")])).toBe("2000.00");
  });

  it("still adds a paired carve-out, matching the expense it offsets", () => {
    expect(
      computeOwnerRunningBalance([
        rent("1000.00"),
        pairedCarveOut("8.46", "aircond_income"),
        L({ category: "utilities_tnb", amount: "188.70" }),
      ]),
    ).toBe("819.76");
  });

  it("stays in lock-step with summarizeOwnerPeriod.netPayoutToOwner", () => {
    const lines = [rent("2000.00"), passThrough("330.00"), L({ category: "management_fee", amount: "216.00" })];
    expect(computeOwnerRunningBalance(lines)).toBe(summarizeOwnerPeriod(lines).netPayoutToOwner);
  });
});
