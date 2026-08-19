import { describe, it, expect } from "vitest";
import { tenantInvoiceNumber, rentChargeNumber, firstOfMonthUtc, tenanciesForPeriodWhere } from "../auto-draft.repository";

describe("auto-draft numbering + period", () => {
  it("builds deterministic tenant invoice number", () => {
    expect(tenantInvoiceNumber("2026-06", "8a646609-1111-2222-3333-444455556666")).toBe("TR-202606-8a646609");
  });
  it("builds deterministic rent charge number with the FULL tenancyId (dedups across cron + tracker)", () => {
    expect(rentChargeNumber("2026-06", "8a646609-1111-2222-3333-444455556666")).toBe(
      "RENT-202606-8a646609-1111-2222-3333-444455556666",
    );
  });
  it("firstOfMonthUtc is the UTC 1st", () => {
    expect(firstOfMonthUtc("2026-06").toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("tenanciesForPeriodWhere", () => {
  // The cron used to select `status: "active"` with no period filter, so it billed
  // whoever lives in the unit TODAY for whatever month it happened to be running —
  // and never billed a tenancy that had since ended, however many days of that month
  // it occupied. The query must be scoped to the period, not to "currently active".
  it("scopes to the org and to tenancies that occupied the month — never to status active", () => {
    const where = tenanciesForPeriodWhere("org-1", new Date(Date.UTC(2026, 6, 1)));

    expect(where.organizationId).toBe("org-1");
    expect(where.status).toEqual({ notIn: ["draft"] });
    expect(where.startDate).toEqual({ lte: new Date("2026-07-31T23:59:59.999Z") });
    expect(where.OR).toEqual([{ endDate: null }, { endDate: { gte: new Date("2026-07-01T00:00:00.000Z") } }]);
  });
});
