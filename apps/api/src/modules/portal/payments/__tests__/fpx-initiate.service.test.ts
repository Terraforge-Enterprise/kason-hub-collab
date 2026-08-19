/**
 * Task 2 (sub-project A / FPX) — service-level tests for initiateFpxPaymentService.
 *
 * Mocks: the repo layer (findFpxPaymentByIdempotencyKey + initiateFpxPaymentTx)
 * and the FPX gateway (getFpxGateway). The real service orchestration is
 * exercised: basket dedupe, idempotent replay, the in-tx create, the P2002 race
 * re-fetch, and the gateway redirect call.
 *
 * Sibling files:
 *   - fpx-initiate.test.ts            → route tests (mock the service)
 *   - fpx-initiate.integration.test.ts → real DB (outstanding-unchanged, etc.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";

// ── mock repo (hoisted) ─────────────────────────────────────────────────────
vi.mock("../portal.payments.repository", () => ({
  listPayments: vi.fn(),
  getPaymentReceipt: vi.fn(),
  listPayableCharges: vi.fn(),
  findPaymentByIdempotencyKey: vi.fn(),
  submitMultiPaymentTx: vi.fn(),
  validatePaymentAllocationsTx: vi.fn(),
  findFpxPaymentByIdempotencyKey: vi.fn(),
  initiateFpxPaymentTx: vi.fn(),
  expireStaleInFlightFpxPayments: vi.fn(),
  // Bare vi.fn() resolves undefined — payer info is optional on the gateway call.
  findPartyBillingInfo: vi.fn(),
}));

// ── mock FPX gateway (hoisted) ──────────────────────────────────────────────
// NB: four `../` — the service imports `../../../lib/fpx` from payments/, which
// resolves to src/lib/fpx; from __tests__/ that same module is `../../../../lib/fpx`.
vi.mock("../../../../lib/fpx", () => ({
  getFpxGateway: vi.fn(),
}));

import { findFpxPaymentByIdempotencyKey, initiateFpxPaymentTx, expireStaleInFlightFpxPayments } from "../portal.payments.repository";
import { getFpxGateway } from "../../../../lib/fpx";
import { initiateFpxPaymentService } from "../fpx-initiate.service";

// ── fixtures ────────────────────────────────────────────────────────────────
const SESSION = {
  partyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "org-test-1",
  userId: "user-test-1",
};
const CHARGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VALID_INPUT = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  allocations: [{ chargeId: CHARGE, allocatedAmount: "900.00" }],
};

const gatewayInitiate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  gatewayInitiate.mockResolvedValue({ redirectUrl: "https://mock/redirect?txn=x&amount=900.00" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getFpxGateway).mockReturnValue({ provider: "fpx-mock", initiate: gatewayInitiate } as any);
});

// ── tests ─────────────────────────────────────────────────────────────────
describe("initiateFpxPaymentService", () => {
  it("fresh basket → 200 with {redirectUrl, providerTxnId, paymentId}; tx + gateway called once", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockResolvedValue({ id: "pay-new", providerTxnId: "txn-new", amount: 900 });

    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      redirectUrl: "https://mock/redirect?txn=x&amount=900.00",
      providerTxnId: "txn-new",
      paymentId: "pay-new",
    });
    expect(initiateFpxPaymentTx).toHaveBeenCalledTimes(1);
    expect(gatewayInitiate).toHaveBeenCalledTimes(1);
    // Gateway gets the freshly-minted txn id and a 2dp amount string.
    expect(gatewayInitiate).toHaveBeenCalledWith(
      expect.objectContaining({ providerTxnId: "txn-new", amount: "900.00" }),
    );
  });

  it("threads actorUserId = session.userId (never partyId) into the tx", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockResolvedValue({ id: "pay-new", providerTxnId: "txn-new", amount: 900 });

    await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(initiateFpxPaymentTx).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: SESSION.userId, organizationId: SESSION.orgId, partyId: SESSION.partyId }),
    );
    expect(initiateFpxPaymentTx).not.toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: SESSION.partyId }),
    );
  });

  it("duplicate chargeId in basket → 400 (no tx, no gateway)", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    const dup = {
      ...VALID_INPUT,
      allocations: [
        { chargeId: CHARGE, allocatedAmount: "450.00" },
        { chargeId: CHARGE, allocatedAmount: "450.00" },
      ],
    };
    const r = await initiateFpxPaymentService(SESSION, dup);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(initiateFpxPaymentTx).not.toHaveBeenCalled();
    expect(gatewayInitiate).not.toHaveBeenCalled();
  });

  it("idempotent replay: prior payment found → reuse its providerTxnId, fresh redirect, NO 2nd tx", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue({ id: "pay-existing", providerTxnId: "txn-existing", amount: 1020 });

    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      redirectUrl: "https://mock/redirect?txn=x&amount=900.00",
      providerTxnId: "txn-existing",
      paymentId: "pay-existing",
    });
    expect(initiateFpxPaymentTx).not.toHaveBeenCalled();
    // Re-initiate uses the EXISTING txn id + the stored amount.
    expect(gatewayInitiate).toHaveBeenCalledWith(
      expect.objectContaining({ providerTxnId: "txn-existing", amount: "1020.00" }),
    );
  });

  it("tx throws CHARGE_NOT_FOUND → 404 (gateway not called)", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(new Error("CHARGE_NOT_FOUND"));
    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(gatewayInitiate).not.toHaveBeenCalled();
  });

  it("tx throws CHARGE_NOT_PAYABLE → 400", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(new Error("CHARGE_NOT_PAYABLE"));
    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
  });

  it("tx throws ALLOC_EXCEEDS_OUTSTANDING → 400", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(new Error("ALLOC_EXCEEDS_OUTSTANDING"));
    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
  });

  it("tx throws BAD_AMOUNT → 400", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(new Error("BAD_AMOUNT"));
    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
  });

  it("tx throws ALLOC_BELOW_OUTSTANDING → 400 (gateway not called)", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(new Error("ALLOC_BELOW_OUTSTANDING"));
    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);
    expect(r.status).toBe(400);
    expect(r.ok).toBe(false);
    expect(gatewayInitiate).not.toHaveBeenCalled();
  });

  // ── Starting a payment NEVER terminates another one ─────────────────────────
  //
  // This used to expire the tenant's own in-flight FPX rows after 30 minutes.
  // Both halves were wrong: on FPX a pending transaction is not a stalled one
  // (every B2B payment answers "pending" first and is resolved later by a second
  // human approving it, with no published maximum duration), and the sweep only
  // ran when the SAME tenant came back — so it never cleared the abandoned rows
  // it was for, while reliably killing live ones it wasn't.
  //
  // Its one legitimate job, unblocking the tenant's own retry, now lives at the
  // guard itself (AWAITING_VERIFICATION_WHERE no longer treats an in-flight FPX
  // attempt as a claim awaiting a human). Expiry is the scheduled requery
  // sweep's job, driven by the gateway's answer rather than by a clock.
  it("does NOT expire anything when a tenant starts a new payment", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(initiateFpxPaymentTx).mockResolvedValue({ id: "pay-new", providerTxnId: "txn-new", amount: 900 });

    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(r.ok).toBe(true);
    // The tenant's earlier attempt may still be live at the bank. Nothing this
    // request does may terminate it.
    expect(expireStaleInFlightFpxPayments).not.toHaveBeenCalled();
    expect(initiateFpxPaymentTx).toHaveBeenCalledTimes(1);
  });

  it("idempotent replay does NOT expire anything (returns the existing payment untouched)", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey).mockResolvedValue({ id: "pay-existing", providerTxnId: "txn-existing", amount: 1020 });

    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(r.ok).toBe(true);
    expect(expireStaleInFlightFpxPayments).not.toHaveBeenCalled();
    expect(initiateFpxPaymentTx).not.toHaveBeenCalled();
  });

  it("P2002 race: tx unique-collides → re-fetch by key → 200 with the raced payment's providerTxnId", async () => {
    vi.mocked(findFpxPaymentByIdempotencyKey)
      .mockResolvedValueOnce(null) // fast-path miss
      .mockResolvedValueOnce({ id: "pay-raced", providerTxnId: "txn-raced", amount: 900 }); // re-fetch hit
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    vi.mocked(initiateFpxPaymentTx).mockRejectedValue(p2002);

    const r = await initiateFpxPaymentService(SESSION, VALID_INPUT);

    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      redirectUrl: "https://mock/redirect?txn=x&amount=900.00",
      providerTxnId: "txn-raced",
      paymentId: "pay-raced",
    });
    expect(gatewayInitiate).toHaveBeenCalledWith(
      expect.objectContaining({ providerTxnId: "txn-raced", amount: "900.00" }),
    );
  });
});
