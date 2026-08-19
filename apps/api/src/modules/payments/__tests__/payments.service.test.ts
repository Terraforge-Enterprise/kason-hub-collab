import { beforeEach, describe, expect, it, vi } from "vitest";
import { allocatePaymentService, createPaymentService } from "../payments.service";
import * as repo from "../payments.repository";

vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  listPayments: vi.fn(),
  findPaymentByNumber: vi.fn(),
  createPayment: vi.fn(),
  findPaymentById: vi.fn(),
  findPaymentForMutation: vi.fn(),
  findChargeById: vi.fn(),
  allocatePaymentTx: vi.fn(),
  updatePaymentStatus: vi.fn(),
}));

const mockedRepo = vi.mocked(repo);
const session = { userId: "u1", orgId: "o1", role: "admin" };

describe("payments.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks duplicate payment number", async () => {
    mockedRepo.findPaymentByNumber.mockResolvedValueOnce({ id: "dup" } as never);

    const res = await createPaymentService(session, {
      paymentNumber: "PMT-001",
      partyId: "11111111-1111-1111-1111-111111111111",
      paymentType: "rent",
      paymentMethod: "bank_transfer",
      amount: "100",
      currency: "MYR",
      receivedAt: "2026-01-01",
      referenceNote: "",
      externalReference: "",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("rejects allocation above outstanding", async () => {
    // B7 reroute: the outstanding cap is no longer pre-checked in the service —
    // it's re-read + capped inside the guarded rail (allocatePaymentTx), which
    // throws ALLOC_EXCEEDS_OUTSTANDING; the service maps that to 400 same as before.
    mockedRepo.findPaymentForMutation.mockResolvedValueOnce({
      id: "p1", amount: 500, status: "posted", partyId: "party-1", idempotencyKey: null, updatedAt: new Date(),
    } as never);
    mockedRepo.findChargeById.mockResolvedValueOnce({ id: "c1", outstandingAmount: 100, status: "posted" } as never);
    mockedRepo.allocatePaymentTx.mockRejectedValueOnce(new Error("ALLOC_EXCEEDS_OUTSTANDING:c1"));

    const res = await allocatePaymentService(session, {
      paymentId: "11111111-1111-1111-1111-111111111111",
      chargeId: "22222222-2222-2222-2222-222222222222",
      allocatedAmount: "300",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});
