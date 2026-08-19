/**
 * Task C2 — service-level tests for submitMultiPaymentService.
 *
 * Mocks: findPaymentByIdempotencyKey + submitMultiPaymentTx (repo layer).
 * The real service logic is exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";

// ── mock repo (hoisted) ────────────────────────────────────────────────────

vi.mock("../portal.payments.repository", () => ({
  listPayments: vi.fn(),
  getPaymentReceipt: vi.fn(),
  listPayableCharges: vi.fn(),
  findPaymentByIdempotencyKey: vi.fn(),
  submitMultiPaymentTx: vi.fn(),
  // The service sweeps the tenant's own abandoned in-flight FPX rows before
  // submitting, so an FPX checkout they walked away from doesn't trip the
  // double-submit guard. Resolves to 0 rows swept by default.
  expireStaleInFlightFpxPayments: vi.fn().mockResolvedValue(0),
}));

import { findPaymentByIdempotencyKey, submitMultiPaymentTx } from "../portal.payments.repository";
import { submitMultiPaymentService } from "../portal.payments.service";

// ── fixtures ───────────────────────────────────────────────────────────────

const SESSION = {
  partyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "org-test-1",
  userId: "user-test-1",
};

const VALID_INPUT = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  paymentMethod: "bank_transfer" as const,
  referenceNumber: "TXN-X",
  allocations: [
    { chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "900.00" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("submitMultiPaymentService", () => {
  it("fast-path: prior key found → 200 replay (tx not called)", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue({ id: "pay-1", paymentNumber: "PAY-EXISTING" });
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "pay-1", paymentNumber: "PAY-EXISTING" });
    expect(submitMultiPaymentTx).not.toHaveBeenCalled();
  });

  it("dup chargeId in basket → 400 (tx not called)", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    const dupInput = {
      ...VALID_INPUT,
      allocations: [
        { chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "450.00" },
        { chargeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", allocatedAmount: "450.00" },
      ],
    };
    const result = await submitMultiPaymentService(SESSION, dupInput);
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
    expect(submitMultiPaymentTx).not.toHaveBeenCalled();
  });

  it("tx throws CHARGE_NOT_FOUND → 404", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(new Error("CHARGE_NOT_FOUND"));
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
  });

  it("tx throws CHARGE_NOT_PAYABLE → 400", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(new Error("CHARGE_NOT_PAYABLE"));
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
  });

  it("tx throws ALLOC_EXCEEDS_OUTSTANDING → 400", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(new Error("ALLOC_EXCEEDS_OUTSTANDING"));
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
  });

  it("tx throws BAD_AMOUNT → 400", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(new Error("BAD_AMOUNT"));
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
  });

  it("tx throws ALLOC_BELOW_OUTSTANDING → 400", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(new Error("ALLOC_BELOW_OUTSTANDING"));
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
  });

  it("tx throws P2002 race → re-fetch by key → 200", async () => {
    vi.mocked(findPaymentByIdempotencyKey)
      .mockResolvedValueOnce(null)                           // fast-path miss
      .mockResolvedValueOnce({ id: "pay-raced", paymentNumber: "PAY-RACED" }); // re-fetch hit
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    vi.mocked(submitMultiPaymentTx).mockRejectedValue(p2002);
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "pay-raced", paymentNumber: "PAY-RACED" });
  });

  it("happy path → 201", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockResolvedValue({ id: "pay-new", paymentNumber: "PAY-NEW" });
    const result = await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(result.status).toBe(201);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "pay-new", paymentNumber: "PAY-NEW" });
  });

  it("actorUserId threaded as session.userId (not partyId)", async () => {
    vi.mocked(findPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(submitMultiPaymentTx).mockResolvedValue({ id: "pay-new", paymentNumber: "PAY-NEW" });
    await submitMultiPaymentService(SESSION, VALID_INPUT);
    expect(submitMultiPaymentTx).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: SESSION.userId }),
    );
    // Must NOT be partyId
    expect(submitMultiPaymentTx).not.toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: SESSION.partyId }),
    );
  });
});
