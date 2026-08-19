import { describe, it, expect } from "vitest";
import {
  voidChargeSchema,
  voidReasonBody,
  PAID_HANDLING_OPTIONS,
  CORRECTION_STRATEGIES,
} from "@kason/shared";

describe("voidChargeSchema (P3 extensions)", () => {
  const base = { chargeId: "3f0b8a52-9c1d-4f6e-8a7b-2c3d4e5f6a7b", reason: "posted in error" };
  const CAT = "b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091";

  it("still accepts the legacy body (chargeId + reason only)", () => {
    expect(voidChargeSchema.safeParse(base).success).toBe(true);
  });

  it("accepts paidHandling hold_credit with no refund details", () => {
    expect(voidChargeSchema.safeParse({ ...base, paidHandling: "hold_credit" }).success).toBe(true);
  });

  it("accepts paidHandling refund WITH refund details", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      paidHandling: "refund",
      refund: { amount: "40.00", method: "bank_transfer", bankRef: "MBB-123", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown paidHandling value", () => {
    expect(voidChargeSchema.safeParse({ ...base, paidHandling: "explode" }).success).toBe(false);
  });

  it("exports the three-way fork options in order", () => {
    expect(PAID_HANDLING_OPTIONS).toEqual(["error_revert_first", "hold_credit", "refund"]);
  });

  it("voidReasonBody requires reason min 3", () => {
    expect(voidReasonBody.safeParse({ reason: "ok" }).success).toBe(false);
    expect(voidReasonBody.safeParse({ reason: "typo in amount" }).success).toBe(true);
  });

  it("rejects refund details without paidHandling", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      refund: { amount: "40.00", method: "bank_transfer", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects refund details when paidHandling is 'hold_credit'", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      paidHandling: "hold_credit",
      refund: { amount: "40.00", method: "bank_transfer", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects paidHandling 'refund' without refund details", () => {
    const parsed = voidChargeSchema.safeParse({ ...base, paidHandling: "refund" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a valid refund combo (paidHandling 'refund' + refund details)", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      paidHandling: "refund",
      refund: { amount: "40.00", method: "bank_transfer", bankRef: "MBB-123", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-decimal refund amount", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      paidHandling: "refund",
      refund: { amount: "abc", method: "bank_transfer", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-YYYY-MM-DD refundedAt", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      paidHandling: "refund",
      refund: { amount: "40.00", method: "bank_transfer", refundedAt: "banana" },
    });
    expect(parsed.success).toBe(false);
  });

  // ── R1 correction strategy extensions ─────────────────────────────────────
  it("exports the four correction strategies in order", () => {
    expect(CORRECTION_STRATEGIES).toEqual([
      "CREDIT_ADJUSTMENT",
      "DEBIT_ADJUSTMENT",
      "CANCEL_AND_REPLACE",
      "REFUND",
    ]);
  });

  it("accepts an explicit strategy (CREDIT_ADJUSTMENT) with no other fields", () => {
    expect(voidChargeSchema.safeParse({ ...base, strategy: "CREDIT_ADJUSTMENT" }).success).toBe(true);
  });

  it("rejects an unknown strategy value", () => {
    expect(voidChargeSchema.safeParse({ ...base, strategy: "EXPLODE" }).success).toBe(false);
  });

  it("accepts strategy REFUND WITH refund details", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "REFUND",
      refund: { amount: "40.00", method: "bank_transfer", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects strategy REFUND WITHOUT refund details (superRefine keys off strategy too)", () => {
    expect(voidChargeSchema.safeParse({ ...base, strategy: "REFUND" }).success).toBe(false);
  });

  it("rejects refund details when strategy is a non-REFUND strategy", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "CREDIT_ADJUSTMENT",
      refund: { amount: "40.00", method: "bank_transfer", refundedAt: "2026-07-02" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an optional replacement block (min 1 line) — additive baseline for Task 8", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [{ categoryId: CAT, description: "Corrected rent", amount: "100.00" }] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a replacement block with zero lines", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "CANCEL_AND_REPLACE",
      replacement: { lines: [] },
    });
    expect(parsed.success).toBe(false);
  });

  // ── R2 DEBIT_ADJUSTMENT amount + idempotency (Task 11 wiring) ──────────────
  it("accepts a DEBIT_ADJUSTMENT adjustmentAmount (2dp decimal string)", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "DEBIT_ADJUSTMENT",
      adjustmentAmount: "50.00",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-decimal adjustmentAmount", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "DEBIT_ADJUSTMENT",
      adjustmentAmount: "fifty",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a uuid idempotencyKey", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "DEBIT_ADJUSTMENT",
      adjustmentAmount: "50.00",
      idempotencyKey: "9a1c2b3d-4e5f-4061-8273-8495a6b7c8d9",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-uuid idempotencyKey", () => {
    const parsed = voidChargeSchema.safeParse({
      ...base,
      strategy: "DEBIT_ADJUSTMENT",
      adjustmentAmount: "50.00",
      idempotencyKey: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
  });
});
