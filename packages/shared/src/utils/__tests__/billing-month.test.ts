import { describe, expect, it } from "vitest";
import { chargeBillingMonth } from "../billing-month";

describe("chargeBillingMonth", () => {
  it("explicit billingMonth wins, normalized to first-of-month UTC", () => {
    expect(chargeBillingMonth({ dueDate: "2026-07-08", billingMonth: "2026-06-15" }))
      .toEqual(new Date(Date.UTC(2026, 5, 1)));
  });

  it("falls back to chargeableFrom when billingMonth is null (legacy rows)", () => {
    expect(chargeBillingMonth({ dueDate: "2026-07-08", billingMonth: null, chargeableFrom: "2026-06-20" }))
      .toEqual(new Date(Date.UTC(2026, 5, 1)));
  });

  it("falls back to dueDate when both are null", () => {
    expect(chargeBillingMonth({ dueDate: new Date("2026-07-08"), billingMonth: null, chargeableFrom: null }))
      .toEqual(new Date(Date.UTC(2026, 6, 1)));
  });
});
