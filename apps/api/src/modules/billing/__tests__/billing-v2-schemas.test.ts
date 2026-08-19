import { describe, it, expect } from "vitest";
import {
  chargesGroupedQuerySchema,
  chargesSummaryQuerySchema,
  paymentsSummaryQuerySchema,
  recordAndAllocatePaymentSchema,
  listChargesQuerySchema,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
} from "@kason/shared";

const BODY = {
  paymentNumber: "PAY-TEST-0001",
  partyId: "44444444-4444-4444-8444-444444444444",
  paymentType: "rental_payment",
  paymentMethod: "bank_transfer",
  currency: "MYR",
  receivedAt: "2026-07-04T10:00:00.000Z",
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  allocations: [
    { chargeId: "22222222-2222-4222-8222-222222222222", allocatedAmount: "1500.00" },
  ],
};

describe("payment enums", () => {
  it("cover every value system flows already write", () => {
    // fpx (portal initiate), credit_note/credit_application (CN auto-apply),
    // bank_transfer/rental_payment (legacy form defaults).
    expect(PAYMENT_METHODS).toContain("fpx");
    expect(PAYMENT_METHODS).toContain("credit_note");
    expect(PAYMENT_METHODS).toContain("bank_transfer");
    expect(PAYMENT_TYPES).toContain("rental_payment");
    expect(PAYMENT_TYPES).toContain("credit_application");
  });
});

describe("recordAndAllocatePaymentSchema", () => {
  it("accepts a valid record-and-allocate body", () => {
    const r = recordAndAllocatePaymentSchema.safeParse(BODY);
    expect(r.success).toBe(true);
  });
  it("rejects unknown method", () => {
    const r = recordAndAllocatePaymentSchema.safeParse({ ...BODY, paymentMethod: "paypal" });
    expect(r.success).toBe(false);
  });
  it("rejects empty allocations", () => {
    const r = recordAndAllocatePaymentSchema.safeParse({ ...BODY, allocations: [] });
    expect(r.success).toBe(false);
  });
  it("has no top-level amount field (server derives Σ allocations)", () => {
    const r = recordAndAllocatePaymentSchema.safeParse({ ...BODY, amount: "9999.00" });
    // zod strips unknown keys by default — amount must NOT survive into data
    expect(r.success).toBe(true);
    if (r.success) expect("amount" in r.data).toBe(false);
  });
});

describe("month params", () => {
  it("accepts bare YYYY-MM", () => {
    expect(chargesGroupedQuerySchema.safeParse({ month: "2026-07", groupBy: "unit" }).success).toBe(true);
    expect(chargesSummaryQuerySchema.safeParse({ month: "2026-07" }).success).toBe(true);
    expect(paymentsSummaryQuerySchema.safeParse({ month: "2026-07" }).success).toBe(true);
  });
  it("rejects YYYY-MM-01", () => {
    expect(chargesGroupedQuerySchema.safeParse({ month: "2026-07-01", groupBy: "unit" }).success).toBe(false);
  });
  it("rejects unknown groupBy", () => {
    expect(chargesGroupedQuerySchema.safeParse({ month: "2026-07", groupBy: "party" }).success).toBe(false);
  });
});

describe("listChargesQuerySchema v2 filters", () => {
  it("keeps page/pageSize optional and accepts the new filters", () => {
    const r = listChargesQuerySchema.safeParse({
      page: "2", pageSize: "25", partyId: "44444444-4444-4444-8444-444444444444",
      outstandingOnly: "true", status: "posted", counterparty: "owner",
      month: "2026-07", q: "RENT-",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.outstandingOnly).toBe(true);
      expect(r.data.counterparty).toBe("owner");
    }
  });
  it("rejects a bad counterparty", () => {
    expect(listChargesQuerySchema.safeParse({ counterparty: "vendor" }).success).toBe(false);
  });
  it("outstandingOnly: 'false' parses to false, 'true' to true (no Boolean() coercion)", () => {
    const off = listChargesQuerySchema.safeParse({ outstandingOnly: "false" });
    expect(off.success).toBe(true);
    if (off.success) expect(off.data.outstandingOnly).toBe(false);
    const on = listChargesQuerySchema.safeParse({ outstandingOnly: "true" });
    expect(on.success).toBe(true);
    if (on.success) expect(on.data.outstandingOnly).toBe(true);
  });
});
