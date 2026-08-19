import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentForMutation: vi.fn(),
  findChargeById: vi.fn(),
  allocatePaymentTx: vi.fn(),
}));
vi.mock("../payments.owner-notify", () => ({ notifyOwnersOfChargesPaid: vi.fn() }));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges: vi.fn() }));
vi.mock("../../billing-documents/status.service", () => ({ refreshDocumentStatusForCharges: vi.fn() }));

import * as repo from "../payments.repository";
import { allocatePaymentService } from "../payments.service";
import { notifyOwnersOfChargesPaid } from "../payments.owner-notify";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";
import { refreshDocumentStatusForCharges } from "../../billing-documents/status.service";

const { PartyMismatchError, StaleError } = repo;
const mockedPayment = vi.mocked(repo.findPaymentForMutation);
const mockedCharge = vi.mocked(repo.findChargeById);
const mockedTx = vi.mocked(repo.allocatePaymentTx);
const mockedNotify = vi.mocked(notifyOwnersOfChargesPaid);
const mockedSync = vi.mocked(syncOwnerLedgerForCharges);
const mockedRefresh = vi.mocked(refreshDocumentStatusForCharges);

const session = { userId: "u1", orgId: "org1", role: "editor" } as never;
const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID = "22222222-2222-4222-8222-222222222222";
const input = { paymentId: PAYMENT_ID, chargeId: CHARGE_ID, allocatedAmount: "100.00" };

beforeEach(() => {
  vi.clearAllMocks();
  mockedPayment.mockResolvedValue({
    id: PAYMENT_ID, amount: { toString: () => "1000" } as never, status: "posted",
    partyId: "party-1", idempotencyKey: null, updatedAt: new Date(),
  });
  mockedCharge.mockResolvedValue({
    id: CHARGE_ID, outstandingAmount: { toString: () => "500" } as never, status: "posted",
  });
});

describe("allocatePaymentService (B7 reroute)", () => {
  it("guarded rail: passes expectedPartyId from the payment to the tx", async () => {
    mockedTx.mockResolvedValue({ id: "al-1", becamePaid: false, chargeId: CHARGE_ID });
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(mockedTx).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPartyId: "party-1", allocatedAmount: 100 }),
    );
  });
  it("party mismatch → 400, and NO post-commit hooks fire (tx rolled back)", async () => {
    mockedTx.mockRejectedValue(new PartyMismatchError(CHARGE_ID));
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 400, error: "Charge does not belong to the payment's payer." });
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
  it("stale → 409, and NO post-commit hooks fire", async () => {
    mockedTx.mockRejectedValue(new StaleError(CHARGE_ID));
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
  it("exceeds outstanding (ALLOC_EXCEEDS_OUTSTANDING from tx) → 400 with the existing message", async () => {
    mockedTx.mockRejectedValue(new Error(`ALLOC_EXCEEDS_OUTSTANDING:${CHARGE_ID}`));
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 400, error: "Allocated amount exceeds outstanding charge amount" });
    expect(mockedNotify).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
  it("payment not found → 404 (findPaymentForMutation swap preserves this)", async () => {
    mockedPayment.mockResolvedValueOnce(null as never);
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 404, error: "Payment not found" });
    expect(mockedTx).not.toHaveBeenCalled();
  });
  it("charge not found → 404", async () => {
    mockedCharge.mockResolvedValueOnce(null as never);
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 404, error: "Charge not found" });
    expect(mockedTx).not.toHaveBeenCalled();
  });
  it("void charge → 400 (pre-check kept, before the tx)", async () => {
    mockedCharge.mockResolvedValueOnce({ id: CHARGE_ID, outstandingAmount: { toString: () => "500" } as never, status: "void" });
    const r = await allocatePaymentService(session, input);
    expect(r).toMatchObject({ ok: false, status: 400, error: "Cannot allocate to void charge" });
    expect(mockedTx).not.toHaveBeenCalled();
  });
  it("non-positive allocatedAmount → 400 (pre-check kept, before the tx)", async () => {
    const r = await allocatePaymentService(session, { ...input, allocatedAmount: "0" });
    expect(r).toMatchObject({ ok: false, status: 400, error: "Allocated amount must be positive" });
    expect(mockedTx).not.toHaveBeenCalled();
  });
  it("post-commit hook throwing StaleError propagates (500), NOT a misleading 409 — allocation already committed", async () => {
    // The error-mapping catch must cover ONLY allocatePaymentTx. If a post-commit
    // hook throws one of the mapped classes AFTER the tx committed, returning a
    // 4xx would tell the client the allocation failed → retry → double allocation
    // (single-allocate has no idempotency key).
    mockedTx.mockResolvedValue({ id: "al-1", becamePaid: false, chargeId: CHARGE_ID });
    mockedSync.mockRejectedValueOnce(new StaleError(CHARGE_ID));
    await expect(allocatePaymentService(session, input)).rejects.toThrow(StaleError);
  });
});
