// Owner WEB statement — expense visibility filter (money-visibility).
//
// Rule (user directive): the owner PDF shows ALL expenses; on the WEB portal the
// owner sees an expense ONLY when it is a tenant-recharge utility (KAEN advanced,
// recovers from the tenant) AND the tenant has FULLY paid — i.e. KAEN actually
// holds the money it spent on the owner's behalf. Owner-borne costs (cleaning,
// cukai, repairs, Source-6 grid expenses), the KAEN mgmt fee, and reversal rows
// are NEVER shown on the web, even when their own charge reads "paid".
//
// The predicate is an ALLOW-LIST on sourceType (the four Source-3 gross utility
// bills) — so a "paid" owner-borne row can never leak through. Pure function;
// applied ONLY on the portal JSON path, so the PDF (which re-assembles its own
// sections) is physically untouched.
import { describe, it, expect } from "vitest";
import {
  filterWebVisibleExpenses,
  utilityRowTenantFunded,
  WEB_VISIBLE_EXPENSE_SOURCE_TYPES,
  type YannieSections,
  type ExpenseBreakdownRow,
} from "../owner-statement-sections";

function row(p: {
  sourceType: string;
  paymentStatus: string;
  amount: string;
  categoryKey?: string;
  sstAmount?: string;
  tenantRecharged?: boolean;
}): ExpenseBreakdownRow {
  return {
    category: p.categoryKey ?? p.sourceType,
    categoryKey: p.categoryKey ?? p.sourceType,
    description: null,
    amount: p.amount,
    sstAmount: p.sstAmount ?? "0.00",
    paymentStatus: p.paymentStatus,
    sourceType: p.sourceType,
    // Default: utilities are tenant-funded unless a test overrides (owner-absorbed).
    tenantRecharged: p.tenantRecharged ?? p.sourceType.startsWith("utility_"),
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
  };
}

// The helper only reads/writes expenseBreakdown; the rest of YannieSections is
// irrelevant to it, so a minimal cast keeps the fixture readable.
function sectionsWith(rows: ExpenseBreakdownRow[]): YannieSections {
  return { expenseBreakdown: { rows, totalExpenses: "999.99" } } as unknown as YannieSections;
}

describe("filterWebVisibleExpenses — owner web statement money visibility", () => {
  it("shows ONLY tenant-recharge utilities the tenant fully paid; hides unpaid/partial and ALL owner-borne (even when 'paid')", () => {
    const out = filterWebVisibleExpenses(
      sectionsWith([
        row({ sourceType: "utility_tnb", paymentStatus: "paid", amount: "400.00" }), // SHOW
        row({ sourceType: "utility_water", paymentStatus: "paid", amount: "50.00" }), // SHOW
        row({ sourceType: "utility_tnb", paymentStatus: "pending", amount: "300.00" }), // hide — tenant unpaid
        row({ sourceType: "utility_tnb", paymentStatus: "partial", amount: "100.00" }), // hide — tenant part-paid
        row({ sourceType: "statement", paymentStatus: "paid", amount: "100.00" }), // hide — cleaning (owner-borne) even PAID
        row({ sourceType: "owner_borne_expense", paymentStatus: "paid", amount: "150.00" }), // hide — owner-borne even PAID
        row({ sourceType: "management_fee", paymentStatus: "paid", amount: "80.00" }), // hide — KAEN fee
        row({ sourceType: "reversal", paymentStatus: "paid", amount: "20.00" }), // hide — reversal
      ]),
    );

    expect(out.expenseBreakdown.rows.map((r) => r.sourceType)).toEqual(["utility_tnb", "utility_water"]);
    expect(out.expenseBreakdown.rows.every((r) => r.paymentStatus === "paid")).toBe(true);
    // totalExpenses recomputed to the visible rows only (400 + 50).
    expect(out.expenseBreakdown.totalExpenses).toBe("450.00");
  });

  it("LEAK FIX: an owner-absorbed utility category (tenantRecharged false) is hidden even when allow-listed + paid", () => {
    const out = filterWebVisibleExpenses(
      sectionsWith([
        row({ sourceType: "utility_tnb", paymentStatus: "paid", amount: "400.00" }), // tenant-funded → show
        row({ sourceType: "utility_wifi", paymentStatus: "paid", amount: "90.00", tenantRecharged: false }), // owner absorbs → HIDE
        row({ sourceType: "utility_indah_water", paymentStatus: "paid", amount: "30.00", tenantRecharged: false }), // owner absorbs → HIDE
        row({ sourceType: "utility_wifi", paymentStatus: "paid", amount: "60.00", tenantRecharged: true }), // recharged → show
      ]),
    );
    expect(out.expenseBreakdown.rows.map((r) => [r.sourceType, r.amount])).toEqual([
      ["utility_tnb", "400.00"],
      ["utility_wifi", "60.00"],
    ]);
    expect(out.expenseBreakdown.totalExpenses).toBe("460.00");
  });

  describe("utilityRowTenantFunded (settings-driven discriminator)", () => {
    it("TNB + water are always tenant-funded (absorbed TNB never reaches the pool)", () => {
      expect(utilityRowTenantFunded("utility_tnb", undefined)).toBe(true);
      expect(utilityRowTenantFunded("utility_water", undefined)).toBe(true);
    });
    it("indah + wifi follow the bill's per-category bearer", () => {
      expect(utilityRowTenantFunded("utility_wifi", { indahWaterBearer: "owner", wifiBearer: "tenant" })).toBe(true);
      expect(utilityRowTenantFunded("utility_wifi", { indahWaterBearer: "owner", wifiBearer: "owner" })).toBe(false);
      expect(utilityRowTenantFunded("utility_indah_water", { indahWaterBearer: "tenant", wifiBearer: "owner" })).toBe(true);
      expect(utilityRowTenantFunded("utility_indah_water", { indahWaterBearer: "owner", wifiBearer: "owner" })).toBe(false);
    });
    it("indah + wifi with NO bearer info fail closed (hidden)", () => {
      expect(utilityRowTenantFunded("utility_wifi", undefined)).toBe(false);
      expect(utilityRowTenantFunded("utility_indah_water", undefined)).toBe(false);
    });
    it("non-utility sourceTypes are never tenant-funded", () => {
      expect(utilityRowTenantFunded("owner_borne_expense", { indahWaterBearer: "tenant", wifiBearer: "tenant" })).toBe(false);
      expect(utilityRowTenantFunded("management_fee", undefined)).toBe(false);
      expect(utilityRowTenantFunded(undefined, undefined)).toBe(false);
    });
  });

  it("allow-list is exactly the four Source-3 tenant-recharge utilities", () => {
    expect([...WEB_VISIBLE_EXPENSE_SOURCE_TYPES].sort()).toEqual(
      ["utility_indah_water", "utility_tnb", "utility_water", "utility_wifi"],
    );
  });

  it("recomputed total includes SST (amount + sstAmount), matching the assembler's own total", () => {
    const out = filterWebVisibleExpenses(
      sectionsWith([row({ sourceType: "utility_tnb", paymentStatus: "paid", amount: "100.00", sstAmount: "8.00" })]),
    );
    expect(out.expenseBreakdown.totalExpenses).toBe("108.00");
  });

  it("nothing qualifies (all owner-borne) → empty rows + 0.00 total", () => {
    const out = filterWebVisibleExpenses(
      sectionsWith([
        row({ sourceType: "owner_borne_expense", paymentStatus: "paid", amount: "150.00" }),
        row({ sourceType: "statement", paymentStatus: "paid", amount: "100.00" }),
      ]),
    );
    expect(out.expenseBreakdown.rows).toEqual([]);
    expect(out.expenseBreakdown.totalExpenses).toBe("0.00");
  });

  it("is pure — does not mutate the input sections (so the shared builder output, hence the PDF path, is untouched)", () => {
    const input = sectionsWith([
      row({ sourceType: "utility_tnb", paymentStatus: "paid", amount: "400.00" }),
      row({ sourceType: "statement", paymentStatus: "paid", amount: "100.00" }),
    ]);
    filterWebVisibleExpenses(input);
    expect(input.expenseBreakdown.rows).toHaveLength(2);
    expect(input.expenseBreakdown.totalExpenses).toBe("999.99");
  });

  it("a row missing sourceType is hidden (fail-closed, never leaks)", () => {
    const bare: ExpenseBreakdownRow = { ...row({ sourceType: "x", paymentStatus: "paid", amount: "10.00" }) };
    delete bare.sourceType; // legacy row with no sourceType (field is optional)
    const out = filterWebVisibleExpenses(sectionsWith([bare]));
    expect(out.expenseBreakdown.rows).toEqual([]);
  });
});
