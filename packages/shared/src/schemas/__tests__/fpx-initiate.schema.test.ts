import { describe, it, expect } from "vitest";
import { fpxInitiateSchema } from "../portal";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("fpxInitiateSchema", () => {
  it("accepts a tenant FPX basket (no paymentMethod/reference — the gateway owns those)", () => {
    const r = fpxInitiateSchema.safeParse({
      idempotencyKey: uuid,
      allocations: [
        { chargeId: uuid, allocatedAmount: "900.00" },
        { chargeId: uuid, allocatedAmount: "120.00", prorateRatio: "0.5000" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-uuid idempotencyKey", () => {
    expect(
      fpxInitiateSchema.safeParse({
        idempotencyKey: "not-a-uuid",
        allocations: [{ chargeId: uuid, allocatedAmount: "1" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty basket", () => {
    expect(
      fpxInitiateSchema.safeParse({ idempotencyKey: uuid, allocations: [] }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid chargeId", () => {
    expect(
      fpxInitiateSchema.safeParse({
        idempotencyKey: uuid,
        allocations: [{ chargeId: "nope", allocatedAmount: "1" }],
      }).success,
    ).toBe(false);
  });

  // NaN-hardening: allocatedAmount was a bare z.string().min(1) with no numeric
  // format check, so "abc" slipped through and later became Number("abc")=NaN
  // reaching payment.create({amount: NaN}). Guarded at the schema (400) layer.
  it("enforces a numeric allocatedAmount format (rejects non-numeric/negative/malformed; accepts valid money strings)", () => {
    const withAmount = (allocatedAmount: string) => fpxInitiateSchema.safeParse({
      idempotencyKey: uuid,
      allocations: [{ chargeId: uuid, allocatedAmount }],
    }).success;

    // rejected — non-numeric / negative / malformed / out-of-format
    expect(withAmount("abc")).toBe(false);
    expect(withAmount("")).toBe(false);
    expect(withAmount("-5")).toBe(false);
    expect(withAmount("1.234")).toBe(false); // more than 2 decimals
    expect(withAmount(" 150.00 ")).toBe(false); // no leading/trailing whitespace
    expect(withAmount("+150.00")).toBe(false); // no leading sign
    expect(withAmount("1e3")).toBe(false); // no scientific notation
    expect(withAmount(".5")).toBe(false); // needs a leading digit
    expect(withAmount("5.")).toBe(false); // needs a digit after the dot
    expect(withAmount("1.2.3")).toBe(false); // only one decimal point
    expect(withAmount("1,500.00")).toBe(false); // no thousands separator

    // accepted — valid money-shaped strings ("0" is format-valid; a ">0" floor
    // is a separate business rule, intentionally out of scope for this regex)
    expect(withAmount("150.00")).toBe(true);
    expect(withAmount("30")).toBe(true);
    expect(withAmount("1.5")).toBe(true); // exactly 1 decimal digit
    expect(withAmount("0")).toBe(true);
    expect(withAmount("0.00")).toBe(true);
  });
});
