/**
 * payment-dedup.test.ts
 * Spec2 R9: best-effort in-window duplicate-payment guard on
 * recordAndAllocatePaymentService. Best-effort by design — NOT a DB
 * constraint; identical payments across longer time spans are legitimate
 * (e.g. next month's rent). The repo-level where-clause-construction test for
 * findRecentDuplicatePayment lives in payments.repository.test.ts (it needs a
 * REAL payments.repository against a mocked @kason/db, which cannot coexist
 * in one file with the partial-repository-mock these service tests need).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial-mock repository: real error classes survive instanceof (convention
// from record-and-allocate.test.ts / payments.batch-service.test.ts).
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentByNumber: vi.fn(),
  findPaymentByIdempotencyKeyAdmin: vi.fn(),
  createPaymentWithAllocationsTx: vi.fn(),
  findRecentDuplicatePayment: vi.fn(),
}));
vi.mock("../payments.owner-notify", () => ({ notifyOwnersOfChargesPaid: vi.fn() }));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges: vi.fn() }));
vi.mock("../../billing-documents/status.service", () => ({ refreshDocumentStatusForCharges: vi.fn() }));

import * as repo from "../payments.repository";
import { recordAndAllocatePaymentService } from "../payments.service";

const mockedFindByNumber = vi.mocked(repo.findPaymentByNumber);
const mockedFindByKey = vi.mocked(repo.findPaymentByIdempotencyKeyAdmin);
const mockedTx = vi.mocked(repo.createPaymentWithAllocationsTx);
const mockedFindRecentDup = vi.mocked(repo.findRecentDuplicatePayment);

const session = { userId: "u1", orgId: "org1", role: "editor" } as never;
const CHARGE_A = "22222222-2222-4222-8222-222222222222";
const INPUT = {
  paymentNumber: "PAY-1",
  partyId: "44444444-4444-4444-8444-444444444444",
  paymentType: "rental_payment" as const,
  paymentMethod: "bank_transfer" as const,
  currency: "MYR",
  receivedAt: "2026-07-04T10:00:00.000Z",
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  allocations: [{ chargeId: CHARGE_A, allocatedAmount: "321.50" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindByNumber.mockResolvedValue(null);
  mockedFindByKey.mockResolvedValue(null);
  mockedFindRecentDup.mockResolvedValue(null);
});

describe("recordAndAllocatePaymentService — duplicate-payment guard (Spec2 R9)", () => {
  it("dup within window: an existing posted payment (same party+amount+method, overlapping charge) → 409 DUPLICATE_PAYMENT with existingPaymentId, tx never called", async () => {
    mockedFindRecentDup.mockResolvedValue({ id: "existing-payment-1" });
    // Would succeed if the guard did not fire — pins the failure to "guard
    // missing" (wrong result) rather than an unrelated mock-shape crash.
    mockedTx.mockResolvedValue({
      paymentId: "should-not-be-created",
      allocations: [],
      paidChargeIds: [],
      allocatedChargeIds: [],
    });

    const r = await recordAndAllocatePaymentService(session, INPUT);

    expect(r).toEqual({
      ok: false,
      status: 409,
      error: "DUPLICATE_PAYMENT",
      existingPaymentId: "existing-payment-1",
    });
    expect(mockedTx).not.toHaveBeenCalled();
  });

  it("outside window: findRecentDuplicatePayment finds nothing (30 min ago is outside the 10-min window) → guard does not fire, proceeds to create (201)", async () => {
    // The window arithmetic itself lives in findRecentDuplicatePayment (repo
    // level, tested in payments.repository.test.ts with deterministic fake
    // timers). Here the repo call is mocked opaque — a null return is exactly
    // what a real 30-min-old prior payment would produce against the 10-min
    // window, so this pins the service's branch on that boundary result.
    mockedFindRecentDup.mockResolvedValue(null);
    mockedTx.mockResolvedValue({
      paymentId: "pay-new",
      allocations: [{ id: "al-1", chargeId: CHARGE_A, allocatedAmount: 321.5 }],
      paidChargeIds: [CHARGE_A],
      allocatedChargeIds: [CHARGE_A],
    });

    const r = await recordAndAllocatePaymentService(session, INPUT);

    expect(r).toMatchObject({ ok: true, status: 201, data: { id: "pay-new" } });
    expect(mockedTx).toHaveBeenCalledTimes(1);
  });

  it("passes the RAW summed amount to the repo unrounded — findRecentDuplicatePayment now owns cent-rounding via Prisma.Decimal (Spec2 R9 adversarial-review fix: a service-side Math.round(amount*100)/100 disagreed with Postgres's numeric(12,2) half-up storage for 3dp inputs, e.g. 1.005 -> Math.round gave 1.00 but the stored row was 1.01, silently missing a real duplicate), so float summation noise (100.10 + 200.20 = 300.29999999999995 in JS) is no longer pre-rounded here", async () => {
    const CHARGE_B = "55555555-5555-4555-8555-555555555555";
    mockedFindRecentDup.mockResolvedValue(null);
    mockedTx.mockResolvedValue({
      paymentId: "pay-new",
      allocations: [],
      paidChargeIds: [],
      allocatedChargeIds: [],
    });

    await recordAndAllocatePaymentService(session, {
      ...INPUT,
      allocations: [
        { chargeId: CHARGE_A, allocatedAmount: "100.10" },
        { chargeId: CHARGE_B, allocatedAmount: "200.20" },
      ],
    });

    expect(mockedFindRecentDup).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ amount: 300.29999999999995 }),
    );
  });

  it("idempotencyKey replay short-circuits BEFORE the dup-guard runs: a legitimate retry with the SAME key never gets treated as a duplicate, even when one would otherwise be found", async () => {
    mockedFindByKey.mockResolvedValue({ id: "replayed-payment" });
    mockedFindRecentDup.mockResolvedValue({ id: "some-other-dup" });

    const r = await recordAndAllocatePaymentService(session, INPUT);

    expect(r).toEqual({ ok: true, status: 200, data: { id: "replayed-payment", replayed: true } });
    expect(mockedFindRecentDup).not.toHaveBeenCalled();
  });
});
