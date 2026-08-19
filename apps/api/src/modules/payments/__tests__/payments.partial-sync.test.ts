/**
 * I-1 — a PARTIAL payment must IMMEDIATELY re-sync the owner-ledger.
 *
 * The payment services pass only the FULLY-PAID charge ids to
 * notifyOwnersOfChargesPaid (owners are notified only when a charge is fully paid),
 * but ALL touched charge ids — partial OR full — to syncOwnerLedgerForCharges, so
 * the owner-ledger's "collected" projection refreshes the instant a partial payment
 * reduces a charge's outstanding (instead of reading stale until some later trigger).
 *
 * Spy-based: the repository txs + the two post-commit hooks are mocked, so this
 * pins the exact call arguments without touching the DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial-mock the repository so real error classes survive instanceof; stub the txs.
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentById: vi.fn(),
  findChargeById: vi.fn(),
  findPaymentForMutation: vi.fn(),
  allocatePaymentTx: vi.fn(),
  allocatePaymentBatchTx: vi.fn(),
  postPaymentTx: vi.fn(),
}));

// Spy the two post-commit hooks.
vi.mock("../payments.owner-notify", () => ({
  notifyOwnersOfChargesPaid: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({
  syncOwnerLedgerForCharges: vi.fn().mockResolvedValue(undefined),
}));

import * as repo from "../payments.repository";
import { notifyOwnersOfChargesPaid } from "../payments.owner-notify";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";
import {
  allocatePaymentService,
  allocatePaymentBatchService,
  postPaymentService,
} from "../payments.service";

const mockedAllocTx = vi.mocked(repo.allocatePaymentTx);
const mockedBatchTx = vi.mocked(repo.allocatePaymentBatchTx);
const mockedPostTx = vi.mocked(repo.postPaymentTx);
const mockedFindChargeById = vi.mocked(repo.findChargeById);
const mockedFindForMutation = vi.mocked(repo.findPaymentForMutation);
const mockedNotify = vi.mocked(notifyOwnersOfChargesPaid);
const mockedSync = vi.mocked(syncOwnerLedgerForCharges);

const session = { userId: "u1", orgId: "org1", role: "manager" };
const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE = "22222222-2222-4222-8222-222222222222";
const PARTY = "44444444-4444-4444-8444-444444444444";
const IDEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => vi.clearAllMocks());

// ── allocatePaymentService (single allocation) ───────────────────────────────
describe("allocatePaymentService — partial vs full owner-ledger sync", () => {
  it("PARTIAL: syncs the touched charge, does NOT notify", async () => {
    // B7 reroute: allocatePaymentService now fetches the payment via
    // findPaymentForMutation (need partyId for the guarded rail), not findPaymentById.
    mockedFindForMutation.mockResolvedValueOnce({ id: PAYMENT_ID, amount: { toString: () => "1000" } as never, status: "posted", partyId: PARTY, idempotencyKey: null, updatedAt: new Date() } as never);
    mockedFindChargeById.mockResolvedValueOnce({ id: CHARGE, outstandingAmount: 1000, status: "posted" } as never);
    // 200 of a 1000 charge → stays partially_paid (becamePaid:false).
    mockedAllocTx.mockResolvedValueOnce({ id: "al1", becamePaid: false, chargeId: CHARGE } as never);

    const res = await allocatePaymentService(session, { paymentId: PAYMENT_ID, chargeId: CHARGE, allocatedAmount: "200" });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it("FULL: syncs AND notifies the touched charge", async () => {
    mockedFindForMutation.mockResolvedValueOnce({ id: PAYMENT_ID, amount: { toString: () => "1000" } as never, status: "posted", partyId: PARTY, idempotencyKey: null, updatedAt: new Date() } as never);
    mockedFindChargeById.mockResolvedValueOnce({ id: CHARGE, outstandingAmount: 1000, status: "posted" } as never);
    mockedAllocTx.mockResolvedValueOnce({ id: "al1", becamePaid: true, chargeId: CHARGE } as never);

    const res = await allocatePaymentService(session, { paymentId: PAYMENT_ID, chargeId: CHARGE, allocatedAmount: "1000" });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).toHaveBeenCalledWith("org1", [CHARGE]);
  });
});

// ── allocatePaymentBatchService ──────────────────────────────────────────────
describe("allocatePaymentBatchService — partial vs full owner-ledger sync", () => {
  const postedPayment = { id: PAYMENT_ID, amount: { toString: () => "1000" }, status: "posted", partyId: PARTY, idempotencyKey: null, updatedAt: new Date() };

  it("PARTIAL: syncs ALL touched charges, notifies only the fully-paid set (empty here)", async () => {
    mockedFindForMutation.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockResolvedValueOnce({
      replayed: false,
      allocations: [{ id: "al1", chargeId: CHARGE, allocatedAmount: 200 }],
      paidChargeIds: [],          // nothing reached "paid"
      allocatedChargeIds: [CHARGE], // but this charge WAS touched
    } as never);

    const res = await allocatePaymentBatchService(session, { paymentId: PAYMENT_ID, idempotencyKey: IDEM, allocations: [{ chargeId: CHARGE, allocatedAmount: "200" }] });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).toHaveBeenCalledWith("org1", []);
  });

  it("FULL: syncs ALL touched, notifies the fully-paid set", async () => {
    mockedFindForMutation.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockResolvedValueOnce({
      replayed: false,
      allocations: [{ id: "al1", chargeId: CHARGE, allocatedAmount: 1000 }],
      paidChargeIds: [CHARGE],
      allocatedChargeIds: [CHARGE],
    } as never);

    const res = await allocatePaymentBatchService(session, { paymentId: PAYMENT_ID, idempotencyKey: IDEM, allocations: [{ chargeId: CHARGE, allocatedAmount: "1000" }] });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).toHaveBeenCalledWith("org1", [CHARGE]);
  });
});

// ── postPaymentService ───────────────────────────────────────────────────────
describe("postPaymentService — partial vs full owner-ledger sync", () => {
  it("PARTIAL: syncs ALL touched charges, notifies only the fully-paid set (empty here)", async () => {
    mockedPostTx.mockResolvedValueOnce({ ok: true, paidChargeIds: [], allocatedChargeIds: [CHARGE] } as never);
    const res = await postPaymentService(session, { paymentId: PAYMENT_ID });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).toHaveBeenCalledWith("org1", []);
  });

  it("FULL: syncs ALL touched, notifies the fully-paid set", async () => {
    mockedPostTx.mockResolvedValueOnce({ ok: true, paidChargeIds: [CHARGE], allocatedChargeIds: [CHARGE] } as never);
    const res = await postPaymentService(session, { paymentId: PAYMENT_ID });
    expect(res.ok).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith("org1", "u1", "manager", [CHARGE]);
    expect(mockedNotify).toHaveBeenCalledWith("org1", [CHARGE]);
  });
});
