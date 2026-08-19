import { describe, it, expect } from "vitest";
import { listChargesQuerySchema } from "../billing";

describe("listChargesQuerySchema (spec §4.8 charges-register pagination gap)", () => {
  it("both params optional and undefined by default — the pagination switch is presence, not a default value", () => {
    const parsed = listChargesQuerySchema.parse({});
    expect(parsed.page).toBeUndefined();
    expect(parsed.pageSize).toBeUndefined();
  });

  it("coerces string query values to numbers", () => {
    const parsed = listChargesQuerySchema.parse({ page: "2", pageSize: "50" });
    expect(parsed).toEqual({ page: 2, pageSize: 50 });
  });

  it("rejects pageSize above 100", () => {
    expect(listChargesQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });

  it("rejects page below 1 and non-integer values", () => {
    expect(listChargesQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(listChargesQuerySchema.safeParse({ page: "1.5" }).success).toBe(false);
  });

  it("accepts pageSize at the max boundary (100)", () => {
    expect(listChargesQuerySchema.safeParse({ pageSize: "100" }).success).toBe(true);
  });
});
