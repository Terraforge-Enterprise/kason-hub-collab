import { describe, it, expect } from "vitest";
import { createTenancySchema } from "../tenancy";

describe("createTenancySchema reservation sourcing", () => {
  const base = { propertyId: crypto.randomUUID(), unitId: crypto.randomUUID(), tenantPartyId: crypto.randomUUID(), tenancyCode: "T-1", startDate: "2026-01-01" };

  it("accepts reservationId without monthlyRentAmount", () => {
    const r = createTenancySchema.safeParse({ ...base, reservationId: crypto.randomUUID() });
    expect(r.success).toBe(true);
  });
  it("accepts monthlyRentAmount without reservationId", () => {
    const r = createTenancySchema.safeParse({ ...base, monthlyRentAmount: "2200" });
    expect(r.success).toBe(true);
  });
  it("rejects when neither rent nor reservationId is given", () => {
    const r = createTenancySchema.safeParse({ ...base });
    expect(r.success).toBe(false);
  });

  it("passes through overwrite:true (T9 manual-path overwrite flag)", () => {
    const r = createTenancySchema.safeParse({ ...base, monthlyRentAmount: "2200", overwrite: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.overwrite).toBe(true);
  });
});
