import { describe, it, expect } from "vitest";
import { createTenancySchema } from "../tenancy";

// Version(4)/variant(8) nibbles set so Zod v4's strict uuid() format check
// accepts these (matches the convention in tenancy.commission.test.ts).
const base = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitId: "22222222-2222-4222-8222-222222222222",
  tenantPartyId: "33333333-3333-4333-8333-333333333333",
  startDate: "2026-08-01",
  monthlyRentAmount: "3000",
};

describe("createTenancySchema tenancyCode", () => {
  it("accepts a create with no tenancyCode — the server generates TEN-{year}-NNNN", () => {
    const r = createTenancySchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tenancyCode).toBeUndefined();
  });

  it("still accepts an explicitly supplied tenancyCode (import / API callers)", () => {
    const r = createTenancySchema.safeParse({ ...base, tenancyCode: "TEN-2026-0001" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tenancyCode).toBe("TEN-2026-0001");
  });

  it("rejects an empty-string tenancyCode rather than silently generating one", () => {
    // "" is a caller mistake, not an omission: a blank code must never fall
    // through to the generator and look like a deliberate auto-assign.
    const r = createTenancySchema.safeParse({ ...base, tenancyCode: "" });
    expect(r.success).toBe(false);
  });
});
