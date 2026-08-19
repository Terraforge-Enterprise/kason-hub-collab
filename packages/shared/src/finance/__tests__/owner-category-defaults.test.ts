// packages/shared/src/finance/__tests__/owner-category-defaults.test.ts
//
// Tests for:
//   1. OWNER_CATEGORY_DEFAULTS — coverage, shape, lock flags
//   2. ownerLedgerEntryInput — payout direction now accepted (and bad payouts rejected)
//   3. summarizeOwnerPeriod — payoutsTotal field
//   4. computeOwnerRunningBalance — incl. negative carry-forward worked example
import { describe, it, expect } from "vitest";
import {
  OWNER_LEDGER_CATEGORIES,
  OWNER_CATEGORY_DEFAULTS,
  ownerLedgerEntryInput,
} from "../../schemas/owner-ledger";
import {
  summarizeOwnerPeriod,
  computeOwnerRunningBalance,
  type OwnerLedgerLine,
} from "../owner-net-payout";

// ── Helper ─────────────────────────────────────────────────────────────────────

const L = (p: Partial<OwnerLedgerLine>): OwnerLedgerLine => ({
  direction: "expense",
  category: "other_expense",
  amount: "0.00",
  sstAmount: null,
  includeInPayout: true,
  taxCategory: "rental_expense",
  ...p,
});

// Canonical RFC v4 UUID fixtures (third group starts "4", fourth group starts "8"-"b").
// Plain "00000000-0000-0000-..." is NOT v4 — Zod's .uuid() rejects it.
const OWNER_ID    = "00000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000002";

// Minimal valid payout entry for input validation tests
const validPayoutInput = {
  ownerPartyId: OWNER_ID,
  propertyId:   PROPERTY_ID,
  statementMonth: "2026-06",
  transactionDate: "2026-06-15",
  direction: "payout" as const,
  category: "owner_payout" as const,
  amount: "3700.00",
  paidBy: "kaen" as const,
  paymentStatus: "paid" as const,
  taxCategory: "not_applicable" as const,
};

// ── 1. OWNER_CATEGORY_DEFAULTS coverage ───────────────────────────────────────

describe("OWNER_CATEGORY_DEFAULTS", () => {
  it("covers every category in OWNER_LEDGER_CATEGORIES", () => {
    const missing = OWNER_LEDGER_CATEGORIES.filter((cat) => !(cat in OWNER_CATEGORY_DEFAULTS));
    expect(missing).toEqual([]);
  });

  it("has the required shape fields for every entry", () => {
    for (const [cat, def] of Object.entries(OWNER_CATEGORY_DEFAULTS)) {
      expect(typeof def.defaultPaidBy, `${cat}.defaultPaidBy`).toBe("string");
      expect(typeof def.includeInPayout, `${cat}.includeInPayout`).toBe("boolean");
      expect(typeof def.defaultTaxCategory, `${cat}.defaultTaxCategory`).toBe("string");
      expect(typeof def.paidByLocked, `${cat}.paidByLocked`).toBe("boolean");
    }
  });

  it("marks operating categories as paidByLocked=true", () => {
    const operating = [
      "management_fee", "maintenance_fee", "sinking_fund", "repair_maintenance",
      "utilities_tnb", "water", "indah_water", "wifi", "aircond", "cleaning",
      "aircond_service", "plumbing", "electrical_repair", "access_card", "furniture_appliance",
    ];
    for (const cat of operating) {
      expect(OWNER_CATEGORY_DEFAULTS[cat]!.paidByLocked, `${cat} should be locked`).toBe(true);
    }
  });

  it("marks statutory categories as paidByLocked=false (overridable)", () => {
    const statutory = ["assessment", "quit_rent", "cukai_petak", "fire_insurance", "legal_fee", "stamp_duty", "agent_commission"];
    for (const cat of statutory) {
      expect(OWNER_CATEGORY_DEFAULTS[cat]!.paidByLocked, `${cat} should be unlocked`).toBe(false);
    }
  });

  it("sets furniture_appliance taxCategory to capital_expense", () => {
    expect(OWNER_CATEGORY_DEFAULTS["furniture_appliance"]!.defaultTaxCategory).toBe("capital_expense");
  });

  it("sets cleaning and access_card taxCategory to not_applicable", () => {
    expect(OWNER_CATEGORY_DEFAULTS["cleaning"]!.defaultTaxCategory).toBe("not_applicable");
    expect(OWNER_CATEGORY_DEFAULTS["access_card"]!.defaultTaxCategory).toBe("not_applicable");
  });

  it("sets legal_fee and stamp_duty taxCategory to capital_expense", () => {
    expect(OWNER_CATEGORY_DEFAULTS["legal_fee"]!.defaultTaxCategory).toBe("capital_expense");
    expect(OWNER_CATEGORY_DEFAULTS["stamp_duty"]!.defaultTaxCategory).toBe("capital_expense");
  });

  it("marks income categories as includeInPayout=false", () => {
    const income = ["rental_income", "utilities_reimbursement", "repair_reimbursement", "deposit_forfeiture", "other_income"];
    for (const cat of income) {
      expect(OWNER_CATEGORY_DEFAULTS[cat]!.includeInPayout, `${cat} should not be in payout`).toBe(false);
    }
  });

  it("has aircond_income, utility_income, carpark_income in OWNER_LEDGER_CATEGORIES", () => {
    expect(OWNER_LEDGER_CATEGORIES).toContain("aircond_income");
    expect(OWNER_LEDGER_CATEGORIES).toContain("utility_income");
    expect(OWNER_LEDGER_CATEGORIES).toContain("carpark_income");
  });

  it("marks aircond_income, utility_income, carpark_income as includeInPayout=false in OWNER_CATEGORY_DEFAULTS", () => {
    const newIncomeCategories = ["aircond_income", "utility_income", "carpark_income"] as const;
    for (const cat of newIncomeCategories) {
      expect(OWNER_CATEGORY_DEFAULTS[cat], `${cat} must be in OWNER_CATEGORY_DEFAULTS`).toBeDefined();
      expect(OWNER_CATEGORY_DEFAULTS[cat]!.includeInPayout, `${cat} must have includeInPayout=false`).toBe(false);
    }
  });

  it("marks operating and statutory categories as includeInPayout=true", () => {
    const deducted = ["management_fee", "assessment", "quit_rent", "legal_fee"];
    for (const cat of deducted) {
      expect(OWNER_CATEGORY_DEFAULTS[cat]!.includeInPayout, `${cat} should be in payout`).toBe(true);
    }
  });

  it("owner_payout: paidByLocked=true, includeInPayout=false, taxCategory=not_applicable", () => {
    const d = OWNER_CATEGORY_DEFAULTS["owner_payout"]!;
    expect(d.defaultPaidBy).toBe("kaen");
    expect(d.paidByLocked).toBe(true);
    expect(d.includeInPayout).toBe(false);
    expect(d.defaultTaxCategory).toBe("not_applicable");
  });
});

// ── 2. ownerLedgerEntryInput — payout validation ───────────────────────────────

describe("ownerLedgerEntryInput — payout validation", () => {
  it("accepts a valid payout entry", () => {
    const result = ownerLedgerEntryInput.safeParse(validPayoutInput);
    expect(result.success).toBe(true);
  });

  it("rejects payout with wrong category", () => {
    const result = ownerLedgerEntryInput.safeParse({
      ...validPayoutInput,
      category: "management_fee",
    });
    expect(result.success).toBe(false);
    const issues = (result as { success: false; error: { issues: { message: string }[] } }).error.issues;
    expect(issues.some((i) => i.message.includes("owner_payout"))).toBe(true);
  });

  it("rejects payout with paidBy !== kaen", () => {
    const result = ownerLedgerEntryInput.safeParse({
      ...validPayoutInput,
      paidBy: "owner",
    });
    expect(result.success).toBe(false);
    const issues = (result as { success: false; error: { issues: { message: string }[] } }).error.issues;
    expect(issues.some((i) => i.message.includes("kaen"))).toBe(true);
  });

  it("still accepts a normal income entry (no regression)", () => {
    const result = ownerLedgerEntryInput.safeParse({
      ownerPartyId: OWNER_ID,
      propertyId:   PROPERTY_ID,
      statementMonth: "2026-06",
      transactionDate: "2026-06-01",
      direction: "income",
      category: "rental_income",
      amount: "2500.00",
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
    });
    expect(result.success).toBe(true);
  });

  it("still accepts a normal expense entry (no regression)", () => {
    const result = ownerLedgerEntryInput.safeParse({
      ownerPartyId: OWNER_ID,
      propertyId:   PROPERTY_ID,
      statementMonth: "2026-06",
      transactionDate: "2026-06-01",
      direction: "expense",
      category: "management_fee",
      amount: "250.00",
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "rental_expense",
    });
    expect(result.success).toBe(true);
  });
});

// ── 3. summarizeOwnerPeriod — payoutsTotal ─────────────────────────────────────

describe("summarizeOwnerPeriod — payoutsTotal", () => {
  it("accumulates payout lines into payoutsTotal without affecting expenses", () => {
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "350.00",  includeInPayout: true  }),
      L({ direction: "payout",  category: "owner_payout",   amount: "4000.00", includeInPayout: false }),
    ];
    const s = summarizeOwnerPeriod(lines);
    expect(s.grossRental).toBe("5300.00");
    expect(s.totalExpenses).toBe("350.00");
    expect(s.payoutsTotal).toBe("4000.00");
    // netPayoutToOwner = income − includeInPayout-expenses = 5300 − 350 = 4950
    expect(s.netPayoutToOwner).toBe("4950.00");
    // netRentalAfterExpenses = income − ALL expenses (payout is NOT an expense)
    expect(s.netRentalAfterExpenses).toBe("4950.00");
  });

  it("returns payoutsTotal of 0.00 when no payout lines", () => {
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income",  amount: "2500.00", includeInPayout: false }),
    ];
    const s = summarizeOwnerPeriod(lines);
    expect(s.payoutsTotal).toBe("0.00");
  });
});

// ── 4. computeOwnerRunningBalance — incl. negative carry-forward ───────────────

describe("computeOwnerRunningBalance", () => {
  it("returns 0.00 for empty lines", () => {
    expect(computeOwnerRunningBalance([])).toBe("0.00");
  });

  it("basic: income only", () => {
    const lines = [L({ direction: "income", category: "rental_income", amount: "5300.00", includeInPayout: false })];
    expect(computeOwnerRunningBalance(lines)).toBe("5300.00");
  });

  it("basic: income minus includeInPayout-expenses", () => {
    const lines = [
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "350.00",  includeInPayout: true  }),
    ];
    expect(computeOwnerRunningBalance(lines)).toBe("4950.00");
  });

  it("owner-paid expense (includeInPayout=false) is NOT deducted from balance — stored flag governs", () => {
    // Both `assessment` and `other_expense` have category default includeInPayout:true,
    // but the STORED flag on the line is false (owner-paid / overridden).
    // The running balance must respect the stored flag, not the category default.
    const linesAssessment: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income", amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "assessment",    amount: "400.00",  includeInPayout: false }),
    ];
    // assessment default is true, but stored false → NOT deducted → balance = 5300
    expect(computeOwnerRunningBalance(linesAssessment)).toBe("5300.00");

    const linesOther: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income", amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "other_expense", amount: "400.00",  includeInPayout: false }),
    ];
    // other_expense default is true, but stored false → NOT deducted → balance = 5300
    expect(computeOwnerRunningBalance(linesOther)).toBe("5300.00");
  });

  it("negative carry-forward worked example: June income 5300, expenses 6000 → balance -700", () => {
    const juneLines: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "6000.00", includeInPayout: true  }),
    ];
    // Balance through June: 5300 − 6000 = −700
    expect(computeOwnerRunningBalance(juneLines)).toBe("-700.00");
  });

  it("negative carry recovers in July: June(−700) + July income 5300, expenses 900 → cumulative +3700", () => {
    const allLines: OwnerLedgerLine[] = [
      // June
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "6000.00", includeInPayout: true  }),
      // July
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount:  "900.00", includeInPayout: true  }),
    ];
    // Cumulative: (5300 − 6000) + (5300 − 900) = −700 + 4400 = 3700
    expect(computeOwnerRunningBalance(allLines)).toBe("3700.00");
  });

  it("a 3700 payout after cumulative balance 3700 → 0", () => {
    const allLines: OwnerLedgerLine[] = [
      // June
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "6000.00", includeInPayout: true  }),
      // July
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount:  "900.00", includeInPayout: true  }),
      // Payout clears the balance
      L({ direction: "payout",  category: "owner_payout",   amount: "3700.00", includeInPayout: false }),
    ];
    // 3700 − 3700 = 0
    expect(computeOwnerRunningBalance(allLines)).toBe("0.00");
  });

  it("reconciliation regression: carriedForward == broughtForward + netThisPeriod − payouts for owner-overridden statutory", () => {
    // Scenario: owner has overridden `assessment` to includeInPayout:false (they paid directly).
    // BF=1000, income=5300, mgmt_fee=530 (included), assessment=400 (excluded), payout=4000
    // netThisPeriod (payout-calc) = 5300 − 530 = 4770
    // carriedForward = BF + netThisPeriod − payouts = 1000 + 4770 − 4000 = 1770
    const allLines: OwnerLedgerLine[] = [
      // Prior period brought-forward represented as carry-in income
      L({ direction: "income",  category: "rental_income",  amount: "1000.00", includeInPayout: false }),
      // Current period
      L({ direction: "income",  category: "rental_income",  amount: "5300.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount:  "530.00", includeInPayout: true  }),
      L({ direction: "expense", category: "assessment",     amount:  "400.00", includeInPayout: false }), // owner-overridden
      L({ direction: "payout",  category: "owner_payout",   amount: "4000.00", includeInPayout: false }),
    ];
    const carriedForward = computeOwnerRunningBalance(allLines);
    expect(carriedForward).toBe("1770.00");
    // Identity check: CF == BF + (income − payoutExpenses) − payouts
    const broughtForward = 1000;
    const netThisPeriod = 5300 - 530; // only includeInPayout expenses deducted
    const payouts = 4000;
    expect(parseFloat(carriedForward)).toBe(broughtForward + netThisPeriod - payouts);
  });

  it("partial payout leaves a remaining balance", () => {
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income",  category: "rental_income",  amount: "5000.00", includeInPayout: false }),
      L({ direction: "expense", category: "management_fee", amount: "1000.00", includeInPayout: true  }),
      L({ direction: "payout",  category: "owner_payout",   amount: "2000.00", includeInPayout: false }),
    ];
    // 5000 − 1000 − 2000 = 2000
    expect(computeOwnerRunningBalance(lines)).toBe("2000.00");
  });
});
