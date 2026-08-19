import { describe, it, expect } from "vitest";
import { recurringUpsertSchema, recurringApplySchema } from "../bills-grid";

describe("recurring schemas", () => {
  const valid = { kind: "CUSTOM" as const, name: "Service fee", amount: "150.00", bearer: "tenant" as const, categoryId: "11111111-1111-4111-8111-111111111111", effectiveFromMonth: "2026-08-01" };

  it("accepts a valid upsert body", () => {
    const r = recurringUpsertSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.enabled).toBe(true); // default
  });

  it("rejects an amount with a formula/non-numeric value", () => {
    expect(recurringUpsertSchema.safeParse({ ...valid, amount: "=100" }).success).toBe(false);
  });

  it("rejects an effectiveFromMonth that is not YYYY-MM-DD", () => {
    expect(recurringUpsertSchema.safeParse({ ...valid, effectiveFromMonth: "2026-08" }).success).toBe(false);
  });

  it("apply REQUIRES confirm: true", () => {
    expect(recurringApplySchema.safeParse(valid).success).toBe(false); // no confirm
    expect(recurringApplySchema.safeParse({ ...valid, confirm: true }).success).toBe(true);
    expect(recurringApplySchema.safeParse({ ...valid, confirm: false }).success).toBe(false);
  });
});
