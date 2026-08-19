import { describe, it, expect } from "vitest";
import { recordAndAllocatePaymentSchema } from "../schemas/billing";

const base = {
  paymentNumber: "PAY-1",
  partyId: "11111111-1111-4111-8111-111111111111",
  paymentType: "rental_payment",
  paymentMethod: "bank_transfer",
  receivedAt: "2026-07-13",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  allocations: [{ chargeId: "33333333-3333-4333-8333-333333333333", allocatedAmount: "100.00" }],
};

describe("recordAndAllocatePaymentSchema attachmentKeys", () => {
  it("accepts and preserves attachmentKeys", () => {
    const r = recordAndAllocatePaymentSchema.safeParse({ ...base, attachmentKeys: ["orgs/o/slips/x.jpg"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.attachmentKeys).toEqual(["orgs/o/slips/x.jpg"]);
  });

  it("omits cleanly when not provided", () => {
    const r = recordAndAllocatePaymentSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.attachmentKeys).toBeUndefined();
  });

  it("rejects empty-string keys", () => {
    const r = recordAndAllocatePaymentSchema.safeParse({ ...base, attachmentKeys: ["", ""] });
    expect(r.success).toBe(false);
  });
});
