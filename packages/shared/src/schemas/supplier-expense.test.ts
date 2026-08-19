import { describe, it, expect } from "vitest";
import {
  BORNE_BY,
  borneByFate,
  isFullyAllocated,
  sumAllocationCents,
  supplierExpenseInput,
} from "./supplier-expense";

describe("borneBy fates (P3)", () => {
  it("routes each concrete bearer to its downstream fate", () => {
    expect(borneByFate("tenant")).toBe("expense_bill");
    expect(borneByFate("owner")).toBe("owner_ledger_deduction");
    expect(borneByFate("kaen")).toBe("kaen_opex");
  });
  it("has exactly the three concrete bearers", () => {
    expect([...BORNE_BY]).toEqual(["tenant", "owner", "kaen"]);
  });
});

describe("split invariant (P3)", () => {
  it("accepts allocations that sum to the total", () => {
    expect(isFullyAllocated("400.00", [{ amount: "120.00" }, { amount: "280.00" }])).toBe(true);
  });
  it("rejects under- and over-allocation by a single cent", () => {
    expect(isFullyAllocated("400.00", [{ amount: "120.00" }, { amount: "279.99" }])).toBe(false);
    expect(isFullyAllocated("400.00", [{ amount: "120.00" }, { amount: "280.01" }])).toBe(false);
  });
  it("sums in cents with no float drift", () => {
    expect(sumAllocationCents([{ amount: "0.10" }, { amount: "0.20" }])).toBe(30);
  });
});

describe("supplierExpenseInput schema (P3)", () => {
  const base = {
    supplierName: "ABC Plumbing Sdn Bhd",
    expenseDate: "2026-07-22",
    totalAmount: "400.00",
    allocations: [
      { borneBy: "tenant", amount: "120.00" },
      { borneBy: "owner", amount: "280.00" },
    ],
  };
  it("accepts a valid split across bearers (the 'shared' case)", () => {
    expect(supplierExpenseInput.safeParse(base).success).toBe(true);
  });
  it("rejects when allocations do not sum to the total", () => {
    const bad = { ...base, allocations: [{ borneBy: "tenant", amount: "100.00" }] };
    expect(supplierExpenseInput.safeParse(bad).success).toBe(false);
  });
  it("rejects an unknown bearer (e.g. developer)", () => {
    const bad = { ...base, allocations: [{ borneBy: "developer", amount: "400.00" }] };
    expect(supplierExpenseInput.safeParse(bad).success).toBe(false);
  });

  it("rejects an amount beyond DECIMAL(12,2) (>10 integer digits) — clean 400, not a DB 500", () => {
    const bad = { ...base, totalAmount: "99999999999.99", allocations: [{ borneBy: "owner", amount: "99999999999.99" }] };
    expect(supplierExpenseInput.safeParse(bad).success).toBe(false);
  });

  it("rejects calendar-invalid dates (rollover + NaN) — clean 400, not a wrong period or a 500", () => {
    for (const badDate of ["2025-02-29", "2026-02-30", "2026-13-45", "2026-00-10"]) {
      expect(supplierExpenseInput.safeParse({ ...base, expenseDate: badDate }).success).toBe(false);
    }
    expect(supplierExpenseInput.safeParse({ ...base, expenseDate: "2026-07-22" }).success).toBe(true);
  });

  it("rejects more than 50 allocations (unbounded-insert guard)", () => {
    const many = Array.from({ length: 51 }, () => ({ borneBy: "owner" as const, amount: "1.00" }));
    const bad = { ...base, totalAmount: "51.00", allocations: many };
    expect(supplierExpenseInput.safeParse(bad).success).toBe(false);
  });
});
