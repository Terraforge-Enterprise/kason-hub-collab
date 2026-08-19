/**
 * recordInvoicePaymentSchema — the invoice-scoped "Record payment" contract.
 * Fast (no DB): proves the backend, not just the UI, enforces the transfer slip and
 * derives the amount from allocations (there is no client-supplied total).
 */
import { describe, it, expect } from "vitest";
import { recordInvoicePaymentSchema } from "@kason/shared";

const base = {
  documentId: "11111111-1111-4111-8111-111111111111",
  paymentNumber: "RCV-1",
  receivedAt: "2026-07-20",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  attachmentKeys: ["orgs/o/slip.jpg"],
  allocations: [{ chargeId: "33333333-3333-4333-8333-333333333333", allocatedAmount: "100.00" }],
};

describe("recordInvoicePaymentSchema", () => {
  it("accepts a valid invoice payment carrying a transfer slip", () => {
    expect(recordInvoicePaymentSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a payment with an empty transfer slip (attachmentKeys required)", () => {
    expect(recordInvoicePaymentSchema.safeParse({ ...base, attachmentKeys: [] }).success).toBe(false);
  });

  it("rejects a payment with NO attachmentKeys field at all", () => {
    const { attachmentKeys, ...noSlip } = base;
    void attachmentKeys;
    expect(recordInvoicePaymentSchema.safeParse(noSlip).success).toBe(false);
  });

  it("requires at least one allocation", () => {
    expect(recordInvoicePaymentSchema.safeParse({ ...base, allocations: [] }).success).toBe(false);
  });

  it("has no top-level amount — the server derives it from the allocations", () => {
    const parsed = recordInvoicePaymentSchema.parse(base);
    expect(parsed).not.toHaveProperty("amount");
  });
});
