import { describe, it, expect } from "vitest";
import { createTenancySchema, updateTenancySchema } from "../tenancy";

const base = {
  // Version(4)/variant(8) nibbles set so Zod v4's strict uuid() format check
  // accepts these (matches the convention in tenancy-rent-invoice-fields.test.ts).
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitId: "22222222-2222-4222-8222-222222222222",
  tenantPartyId: "33333333-3333-4333-8333-333333333333",
  tenancyCode: "T-1",
  startDate: "2026-08-01",
  monthlyRentAmount: "3000",
};

describe("commission fields on tenancy schemas", () => {
  it("retains firstMonthIsCommission + commissionSstBearer on create", () => {
    const r = createTenancySchema.safeParse({ ...base, firstMonthIsCommission: true, commissionSstBearer: "kaen" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.firstMonthIsCommission).toBe(true);
      expect(r.data.commissionSstBearer).toBe("kaen");
    }
  });

  it("rejects an invalid bearer on create", () => {
    const r = createTenancySchema.safeParse({ ...base, commissionSstBearer: "landlord" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("commissionSstBearer"))).toBe(true);
  });

  it("retains the fields on update", () => {
    const r = updateTenancySchema.safeParse({ tenancyId: base.propertyId, firstMonthIsCommission: false, commissionSstBearer: "owner" });
    expect(r.success).toBe(true);
  });
});
