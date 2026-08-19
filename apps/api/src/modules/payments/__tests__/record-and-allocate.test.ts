/**
 * record-and-allocate.test.ts
 * Covers Task 5: atomic POST /payments/record-and-allocate.
 *
 * Two describe blocks:
 * 1. recordAndAllocatePaymentService — partial-mocked repository (real error
 *    classes survive instanceof — convention from payments.batch-service.test.ts).
 * 2. createPaymentWithAllocationsTx — repo-level tx test with a mocked
 *    $transaction client (convention from allocatePaymentBatchTx-style tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Partial-mock repository: real error classes survive instanceof (convention
// from payments.batch-service.test.ts).
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentByNumber: vi.fn(),
  findPaymentByIdempotencyKeyAdmin: vi.fn(),
  createPaymentWithAllocationsTx: vi.fn(),
  // Spec2 R9 dup-guard — default null (no recent duplicate) so these
  // pre-existing tests keep exercising the tx path unchanged.
  findRecentDuplicatePayment: vi.fn(),
}));
vi.mock("../payments.owner-notify", () => ({ notifyOwnersOfChargesPaid: vi.fn() }));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges: vi.fn() }));
vi.mock("../../billing-documents/status.service", () => ({ refreshDocumentStatusForCharges: vi.fn() }));

import * as repo from "../payments.repository";
import { recordAndAllocatePaymentService } from "../payments.service";
import { notifyOwnersOfChargesPaid } from "../payments.owner-notify";

const mockedFindByNumber = vi.mocked(repo.findPaymentByNumber);
const mockedFindByKey = vi.mocked(repo.findPaymentByIdempotencyKeyAdmin);
const mockedTx = vi.mocked(repo.createPaymentWithAllocationsTx);
const mockedFindRecentDup = vi.mocked(repo.findRecentDuplicatePayment);
const { PartyMismatchError, StaleError } = repo;

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
  allocations: [{ chargeId: CHARGE_A, allocatedAmount: "1500.00" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindByNumber.mockResolvedValue(null);
  mockedFindByKey.mockResolvedValue(null);
  mockedFindRecentDup.mockResolvedValue(null);
});

describe("recordAndAllocatePaymentService", () => {
  it("atomic happy path: derives amount = Σ allocations, returns 201, fires post-commit hooks", async () => {
    mockedTx.mockResolvedValue({
      paymentId: "pay-1",
      allocations: [{ id: "al-1", chargeId: CHARGE_A, allocatedAmount: 1500 }],
      paidChargeIds: [CHARGE_A],
      allocatedChargeIds: [CHARGE_A],
    });
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(mockedTx).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1500, idempotencyKey: INPUT.idempotencyKey }),
    );
    expect(vi.mocked(notifyOwnersOfChargesPaid)).toHaveBeenCalledWith("org1", [CHARGE_A]);
  });

  it("replay: same idempotencyKey returns 200 replayed without calling the tx", async () => {
    mockedFindByKey.mockResolvedValue({ id: "pay-1" });
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: true, status: 200, data: { id: "pay-1", replayed: true } });
    expect(mockedTx).not.toHaveBeenCalled();
  });

  it("rolls back: exceeds-outstanding throw maps to 400 and no hooks fire", async () => {
    mockedTx.mockRejectedValue(new Error(`ALLOC_EXCEEDS_OUTSTANDING:${CHARGE_A}`));
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(vi.mocked(notifyOwnersOfChargesPaid)).not.toHaveBeenCalled();
  });

  it("party mismatch maps to 400", async () => {
    mockedTx.mockRejectedValue(new PartyMismatchError(CHARGE_A));
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("stale charge maps to 409", async () => {
    mockedTx.mockRejectedValue(new StaleError(CHARGE_A));
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("duplicate paymentNumber maps to 409", async () => {
    mockedFindByNumber.mockResolvedValue({ id: "other" });
    const r = await recordAndAllocatePaymentService(session, INPUT);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a charge repeated in one batch (400)", async () => {
    const r = await recordAndAllocatePaymentService(session, {
      ...INPUT,
      allocations: [
        { chargeId: CHARGE_A, allocatedAmount: "10.00" },
        { chargeId: CHARGE_A, allocatedAmount: "20.00" },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mockedTx).not.toHaveBeenCalled();
  });
});

// ── Repo-level tx test (mocked tx client) ────────────────────────────────────
const { txMock, paymentCreateMock, allocationCreateMock, chargeFindFirstMock, chargeUpdateMock } = vi.hoisted(() => ({
  txMock: vi.fn(),
  paymentCreateMock: vi.fn(),
  allocationCreateMock: vi.fn(),
  chargeFindFirstMock: vi.fn(),
  chargeUpdateMock: vi.fn(),
}));
vi.mock("@kason/db", async (orig) => ({
  ...(await orig()),
  getDb: () => ({
    $transaction: txMock,
  }),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));

describe("createPaymentWithAllocationsTx", () => {
  it("creates payment posted with idempotencyKey then applies each line in the SAME tx", async () => {
    const tx = {
      payment: { create: paymentCreateMock.mockResolvedValue({ id: "pay-9" }) },
      paymentAllocation: { create: allocationCreateMock.mockResolvedValue({ id: "al-1" }) },
      charge: {
        findFirst: chargeFindFirstMock.mockResolvedValue({
          id: CHARGE_A, partyId: INPUT.partyId, amount: { toString: () => "1500" },
          outstandingAmount: { toString: () => "1500" }, status: "posted", updatedAt: new Date(),
        }),
        update: chargeUpdateMock.mockResolvedValue({ id: CHARGE_A }),
      },
    };
    txMock.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const real = (await vi.importActual<typeof repo>("../payments.repository")).createPaymentWithAllocationsTx;
    const out = await real({
      organizationId: "org1", paymentNumber: "PAY-1", partyId: INPUT.partyId,
      paymentType: "rental_payment", paymentMethod: "bank_transfer", amount: 1500,
      currency: "MYR", receivedAt: new Date(INPUT.receivedAt), referenceNote: null,
      externalReference: null, idempotencyKey: INPUT.idempotencyKey,
      attachmentKeys: [],
      actorUserId: "u1", actorRole: "editor",
      allocations: [{ chargeId: CHARGE_A, allocatedAmount: 1500, prorateRatio: null }],
    });
    expect(paymentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "posted", idempotencyKey: INPUT.idempotencyKey }),
      }),
    );
    expect(allocationCreateMock).toHaveBeenCalledTimes(1);
    expect(out.paymentId).toBe("pay-9");
    expect(out.paidChargeIds).toEqual([CHARGE_A]);
  });
});
