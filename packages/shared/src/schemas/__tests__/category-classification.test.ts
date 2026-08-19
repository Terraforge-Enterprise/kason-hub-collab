import { describe, it, expect } from "vitest";
import {
  BEARER_CATEGORY_FAMILY,
  categoriesForBearer,
  createChargeCategoryInput,
  updateChargeCategoryInput,
  type CategoryFamily,
} from "../charge-categories";
import { createExpensesSchema } from "../bills-grid";
const NOW = "2026-07-13T00:00:00.000Z";
// Zod v4's .uuid() enforces RFC-9562 variant bits (4th group starts with 8-b).
// "11111111-1111-1111-1111-111111111111" (brief's literal fixture) fails
// because the 4th group "1111" violates the variant constraint — same
// pre-existing gotcha documented in analytics.test.ts. Use a valid RFC-9562
// UUID for apartmentId; unrelated to the chargeCategoryId field under test.
const VALID_UUID = "00000000-0000-4000-8000-000000000001";
describe("category classification schemas", () => {
  it("accepts profitExpense enum, rejects bogus", () => {
    expect(updateChargeCategoryInput.safeParse({ profitExpense: "expense", expectedUpdatedAt: NOW }).success).toBe(true);
    expect(updateChargeCategoryInput.safeParse({ profitExpense: "bogus", expectedUpdatedAt: NOW }).success).toBe(false);
  });
  it("accepts nullable chargeCategoryId on an expense item, rejects non-uuid", () => {
    const base = { apartmentId: VALID_UUID, billingMonth: "2026-07-01", bearer: "owner", items: [{ description: "x", amount: "1.00", withSST: false, chargeCategoryId: null }] };
    expect(createExpensesSchema.safeParse(base).success).toBe(true);
    expect(createExpensesSchema.safeParse({ ...base, items: [{ ...base.items[0], chargeCategoryId: "nope" }] }).success).toBe(false);
  });
  it("still enforces 'PATCH must change at least one field' — profitExpense-only counts as a change, timestamp-only does not", () => {
    expect(updateChargeCategoryInput.safeParse({ expectedUpdatedAt: NOW }).success).toBe(false);
    expect(updateChargeCategoryInput.safeParse({ profitExpense: "profit", expectedUpdatedAt: NOW }).success).toBe(true);
  });
  it("accepts profitExpense at CREATE (settings Add-category form sets the P&L side up front)", () => {
    const base = { code: "pest_control_owner", name: "Pest control (owner)", family: "owner_income", docType: "invoice", seriesId: VALID_UUID };
    expect(createChargeCategoryInput.safeParse({ ...base, profitExpense: "expense" }).success).toBe(true);
    expect(createChargeCategoryInput.safeParse({ ...base, profitExpense: null }).success).toBe(true);
    // Still optional — a create body without it stays valid (pre-existing callers).
    expect(createChargeCategoryInput.safeParse(base).success).toBe(true);
    expect(createChargeCategoryInput.safeParse({ ...base, profitExpense: "bogus" }).success).toBe(false);
  });
});

describe("categoriesForBearer", () => {
  const cat = (id: string, family: CategoryFamily) => ({ id, family });
  const ALL = [
    cat("t1", "tenant_income"),
    cat("t2", "tenant_income"),
    cat("o1", "owner_income"),
    cat("d1", "pay_back_landlord"),
  ];

  it("offers only owner-side categories on an owner expense sheet", () => {
    expect(categoriesForBearer(ALL, "owner").map((c) => c.id)).toEqual(["o1"]);
  });

  it("offers only tenant-side categories on a tenant expense sheet", () => {
    expect(categoriesForBearer(ALL, "tenant").map((c) => c.id)).toEqual(["t1", "t2"]);
  });

  it("never offers the deposit/rent family to either bearer", () => {
    expect(categoriesForBearer(ALL, "owner").some((c) => c.id === "d1")).toBe(false);
    expect(categoriesForBearer(ALL, "tenant").some((c) => c.id === "d1")).toBe(false);
  });

  // MONEY-SAFETY: a line saved before this filter existed can hold an off-side
  // categoryId. Dropping it from the options would render the <select> blank — the
  // row would read "No category" while state still held the id, silently
  // re-classifying the line on the next save.
  it("keeps a row's existing off-side category in the options", () => {
    const ids = categoriesForBearer(ALL, "owner", ["t1"]).map((c) => c.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("o1");
    expect(ids).not.toContain("t2");
  });

  it("ignores null/undefined keepIds (a row with no category picked)", () => {
    expect(categoriesForBearer(ALL, "owner", [null, undefined]).map((c) => c.id)).toEqual(["o1"]);
  });

  it("maps each bearer to the family its seeded categories actually use", () => {
    expect(BEARER_CATEGORY_FAMILY).toEqual({ tenant: "tenant_income", owner: "owner_income" });
  });
});
