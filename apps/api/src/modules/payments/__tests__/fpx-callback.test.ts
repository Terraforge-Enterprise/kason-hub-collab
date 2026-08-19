/**
 * Task 3 (sub-project A / FPX) — service-level branching tests for
 * handleFpxCallbackService. Mocks the gateway, the callback repo,
 * resolveSystemActor, and postPaymentService so every orchestration branch
 * (idempotency, settle, race-already-posted, reconcile, failed,
 * terminal-resurrect, no-actor) is exercised without a DB.
 *
 * Sibling: fpx-callback.integration.test.ts → real DB money invariants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock gateway (hoisted) ───────────────────────────────────────────────────
// service imports `../../lib/fpx`; from __tests__/ that module is `../../../lib/fpx`.
vi.mock("../../../lib/fpx", () => ({ getFpxGateway: vi.fn() }));

// ── mock the canonical system-actor resolver (hoisted) ───────────────────────
// service imports `../billing/auto-draft.repository`; from __tests__/ → `../../billing/...`.
vi.mock("../../billing/auto-draft.repository", () => ({ resolveSystemActor: vi.fn() }));

// ── mock callback repo (hoisted) ─────────────────────────────────────────────
vi.mock("../fpx-callback.repository", () => ({
  findPaymentByProviderTxnId: vi.fn(),
  setFpxGatewaySuccess: vi.fn(),
  failFpxPaymentTx: vi.fn(),
  persistProviderTranId: vi.fn(),
  reviveSweptFpxPaymentTx: vi.fn(),
  holdForReconciliationTx: vi.fn(),
}));

// ── mock the settle service (hoisted) ────────────────────────────────────────
vi.mock("../payments.service", () => ({ postPaymentService: vi.fn() }));

import { getFpxGateway } from "../../../lib/fpx";
import { resolveSystemActor } from "../../billing/auto-draft.repository";
import {
  findPaymentByProviderTxnId,
  setFpxGatewaySuccess,
  failFpxPaymentTx,
  persistProviderTranId,
  reviveSweptFpxPaymentTx,
  holdForReconciliationTx,
} from "../fpx-callback.repository";
import { postPaymentService } from "../payments.service";
import { handleFpxCallbackService } from "../fpx-callback.service";

const ORG = "org-1";
const PAYMENT_ID = "pay-1";
const ADMIN = "admin-1";
const ACTOR = { actorUserId: ADMIN, actorRole: "admin" as const };
const TXN = "txn-1";
const RAW = JSON.stringify({ providerTxnId: TXN, status: "success" });
const SIG = "sig";

const verifyCallback = vi.fn();

function pending() {
  return { id: PAYMENT_ID, organizationId: ORG, status: "pending_approval", gatewayStatus: "pending", providerTranId: null, amount: "150.00", currency: "MYR" };
}

/** Killed by OUR OWN 30-minute sweep — nobody judged it, a timer did. */
function sweptByTimer() {
  return { id: PAYMENT_ID, organizationId: ORG, status: "expired", gatewayStatus: "expired", providerTranId: null, amount: "150.00", currency: "MYR" };
}

/** Killed by a HUMAN via the admin in-flight cancel — a decision exists. */
function cancelledByAdmin() {
  return { id: PAYMENT_ID, organizationId: ORG, status: "expired", gatewayStatus: "cancelled", providerTranId: null, amount: "150.00", currency: "MYR" };
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getFpxGateway).mockReturnValue({ verifyCallback } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(resolveSystemActor).mockResolvedValue(ACTOR as any);
  vi.mocked(reviveSweptFpxPaymentTx).mockResolvedValue(true);
  // The park LANDS by default. It returns a boolean now (did the status-guarded
  // claim match?), and a bare vi.fn() resolves undefined — which reads as "did
  // not land" and would send every park test down the concurrent-drift branch
  // without failing anything.
  vi.mocked(holdForReconciliationTx).mockResolvedValue(true);
});

describe("handleFpxCallbackService", () => {
  it("invalid signature → 400, never touches the DB (no payment lookup, no settle)", async () => {
    verifyCallback.mockReturnValue({ valid: false, providerTxnId: "", status: "failed" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toEqual({ ok: false, status: 400 });
    expect(findPaymentByProviderTxnId).not.toHaveBeenCalled();
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(failFpxPaymentTx).not.toHaveBeenCalled();
  });

  it("unknown providerTxnId → 404, no settle", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(null);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toEqual({ ok: false, status: 404 });
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("success + pending → settles via postPaymentService (admin actor, role from resolver), stamps success, 200", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: { id: PAYMENT_ID, status: "posted" } } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(postPaymentService).toHaveBeenCalledTimes(1);
    // PaymentsSession mirrors the auto-draft cron: real admin userId + actorRole.
    expect(postPaymentService).toHaveBeenCalledWith(
      { orgId: ORG, userId: ADMIN, role: "admin" },
      { paymentId: PAYMENT_ID },
    );
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID);
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("idempotency: already gatewayStatus=success → 200 no-op, no settle", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ id: PAYMENT_ID, organizationId: ORG, status: "posted", gatewayStatus: "success", providerTranId: null, amount: "150.00", currency: "MYR" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled();
  });

  it("idempotency: already status=posted (gatewayStatus lagging) → 200 no-op, no settle", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ id: PAYMENT_ID, organizationId: ORG, status: "posted", gatewayStatus: "pending", providerTranId: null, amount: "150.00", currency: "MYR" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("success race: settle returns badStatus '(was posted)' → treat as settled, stamp success, 200", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: false, status: 400, error: "Only pending_approval payments can be posted (was posted)" } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID);
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("success but settle fails with a real error (outstanding drift, 409) → reconcile, 200, NOT success", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    // Re-read still shows NOT settled (pending) → a GENUINE failure → reconcile.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: false, status: 409, error: "A charge's outstanding amount changed; this payment can no longer be applied as recorded." } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 }); // ack the gateway so it stops retrying
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled(); // must NOT claim success
    // Parks it PROPERLY — status, notification and audit, same helper the
    // figures-mismatch branch uses. The old audit-log-only write left the row
    // `pending_approval`, invisible to the reconciliation queue and re-swept by
    // the requery cron forever.
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        organizationId: ORG,
        actorUserId: ADMIN,
        actorRole: "admin",
        priorStatus: "pending_approval",
      }),
    );
  });

  it("FIX 3 — true concurrent race: settle returns the 409 StaleError but a re-read shows the payment now posted → NO reconcile flag, stamp success, 200", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    // Step 2 lookup looks pending; by the time the loser's settle returns 409, the
    // re-read shows a concurrent winning callback already posted it.
    vi.mocked(findPaymentByProviderTxnId)
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce({ id: PAYMENT_ID, organizationId: ORG, status: "posted", gatewayStatus: "pending", providerTranId: null, amount: "150.00", currency: "MYR" });
    // A true double-callback loses postPaymentTx's updatedAt-in-WHERE → StaleError
    // → 409 "Changed since you loaded it" (NOT the "(was posted)" 400 fast-path).
    vi.mocked(postPaymentService).mockResolvedValue({ ok: false, status: 409, error: "Changed since you loaded it. Refresh and retry." } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID); // reflect the settled state
    expect(holdForReconciliationTx).not.toHaveBeenCalled(); // NOT a genuine failure — no spurious flag
  });

  // ── Late settlement: a signed success arriving AFTER the row went terminal ──
  //
  // This is the money-loss class the whole change exists for. On FPX a late
  // success is NORMAL, not anomalous: B2B transactions answer "pending" first
  // and are resolved later by a human approver, and neither Fiuu nor PayNet
  // publishes a maximum pending duration. The old behaviour refused these with a
  // 409, which burned Fiuu's 3 retries and lost the money event permanently with
  // nothing persisted to find it by.
  //
  // What we do now depends on WHO ended the payment.

  it("late success after OUR OWN sweep expired it → revives and settles, tenant is credited", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(sweptByTimer());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: { id: PAYMENT_ID, status: "posted" } } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(reviveSweptFpxPaymentTx).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, organizationId: ORG, actorUserId: ADMIN }),
    );
    // The money is actually applied — not merely acknowledged.
    expect(postPaymentService).toHaveBeenCalledWith({ orgId: ORG, userId: ADMIN, role: "admin" }, { paymentId: PAYMENT_ID });
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID);
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("late success after an ADMIN cancelled it → held for review, never auto-settled", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(cancelledByAdmin());

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 }); // ack regardless — never burn a retry
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        organizationId: ORG,
        priorStatus: "expired",
        priorGatewayStatus: "cancelled",
      }),
    );
    // A human decided this; we do not override them automatically.
    expect(reviveSweptFpxPaymentTx).not.toHaveBeenCalled();
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled();
  });

  it("late success for a payment the GATEWAY already failed → held for review, not resurrected", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ id: PAYMENT_ID, organizationId: ORG, status: "failed", gatewayStatus: "failed", providerTranId: null, amount: "150.00", currency: "MYR" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, priorStatus: "failed", priorGatewayStatus: "failed" }),
    );
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled();
  });

  it("a repeat late success on an already-parked row → acks without raising a second notification", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ id: PAYMENT_ID, organizationId: ORG, status: "needs_reconciliation", gatewayStatus: "cancelled", providerTranId: null, amount: "150.00", currency: "MYR" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    // One payment must not generate a queue item per delivery, or whoever works
    // the queue learns to ignore it.
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("late success but the swept row changed underneath us → acks, settles nothing, forces nothing", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(sweptByTimer());
    vi.mocked(reviveSweptFpxPaymentTx).mockResolvedValue(false); // concurrent actor won

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("late success with NO admin actor → acks, but changes nothing it cannot audit", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(sweptByTimer());
    vi.mocked(resolveSystemActor).mockResolvedValue(null);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(reviveSweptFpxPaymentTx).not.toHaveBeenCalled();
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  // ── The gateway's own transaction id ────────────────────────────────────────
  // Fiuu's requery retention is 7 days by our order id but 180 by their tranID,
  // against a 60-day payer dispute window — and it is knowable ONLY from a
  // message they send us.

  it("persists the gateway's tranID the first time any message carries it", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success", providerTranId: "fiuu-9911" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: {} } as any);

    await handleFpxCallbackService(RAW, SIG);

    expect(persistProviderTranId).toHaveBeenCalledWith(PAYMENT_ID, "fiuu-9911");
  });

  it("captures the tranID from a PENDING callback too — often the first message on a B2B flow", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "pending", providerTranId: "fiuu-9911" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(persistProviderTranId).toHaveBeenCalledWith(PAYMENT_ID, "fiuu-9911");
    // Pending still changes NOTHING about the payment itself.
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(failFpxPaymentTx).not.toHaveBeenCalled();
  });

  it("acks a PENDING callback even if the database is unreachable — a retry is too scarce to spend", async () => {
    // Fiuu sends only 3 retries, 15 minutes apart, then stops forever. A pending
    // message carries no money event to lose, so erroring here would spend a
    // retry we may need for the terminal message that follows.
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "pending", providerTranId: "fiuu-9911" });
    vi.mocked(findPaymentByProviderTxnId).mockRejectedValue(new Error("db down"));

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("does NOT swallow a lookup failure on a terminal callback — Fiuu must retry a real money event", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockRejectedValue(new Error("db down"));

    await expect(handleFpxCallbackService(RAW, SIG)).rejects.toThrow("db down");
  });

  it("never overwrites a tranID already stored", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success", providerTranId: "fiuu-DIFFERENT" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ ...pending(), providerTranId: "fiuu-9911" });
    vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: {} } as any);

    await handleFpxCallbackService(RAW, SIG);

    expect(persistProviderTranId).not.toHaveBeenCalled();
  });

  it("a tranID write failure never blocks the settle", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success", providerTranId: "fiuu-9911" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(persistProviderTranId).mockRejectedValue(new Error("db blip"));
    vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: {} } as any);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it("failed callback + pending → marks payment failed (admin actor), 200", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "failed" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(failFpxPaymentTx).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: PAYMENT_ID, organizationId: ORG, actorUserId: ADMIN, actorRole: "admin" }),
    );
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("failed callback + already failed → 200 no-op, no re-write", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "failed" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue({ id: PAYMENT_ID, organizationId: ORG, status: "failed", gatewayStatus: "failed", providerTranId: null, amount: "150.00", currency: "MYR" });

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(failFpxPaymentTx).not.toHaveBeenCalled();
  });

  it("success but NO admin actor → 200 ack, settles nothing, does NOT mark success (left for reconciliation)", async () => {
    verifyCallback.mockReturnValue({ valid: true, providerTxnId: TXN, status: "success" });
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(pending());
    vi.mocked(resolveSystemActor).mockResolvedValue(null);

    const r = await handleFpxCallbackService(RAW, SIG);

    expect(r).toMatchObject({ ok: true, status: 200 }); // ack the gateway, never throw away its money event
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled(); // must NOT claim success
    expect(holdForReconciliationTx).not.toHaveBeenCalled(); // cannot audit-flag without an actor
  });
});
