import crypto from "node:crypto";
import { Prisma } from "@kason/db";
import type { FpxInitiateInput } from "@kason/shared";
import { getFpxGateway, type FpxGateway, type FpxPayerInfo } from "../../../lib/fpx";
import {
  findFpxPaymentByIdempotencyKey,
  findPartyBillingInfo,
  initiateFpxPaymentTx,
} from "./portal.payments.repository";
import { requeryTenantStaleFpx } from "../../payments/fpx-requery.service";

type SessionScope = { partyId: string; orgId: string; userId: string };

type InitiateResult =
  | { ok: true; status: 200; data: { redirectUrl: string; providerTxnId: string; paymentId: string }; error?: undefined }
  | { ok: false; status: 400 | 404 | 409; error: string; data?: undefined };

function genPaymentNumber(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `PAY-${ts}-${rand}`.toUpperCase();
}

// Ask the gateway for a redirect URL for this transaction. Used for both a fresh
// initiate and an idempotent re-initiate, so the gateway always sees the SAME
// providerTxnId for a given basket. The mock ignores returnUrl; the real
// provider substitutes its own API-hosted return route (the SPA cannot receive
// the gateway's browser POST) and shows `payer` on its hosted page.
async function gatewayRedirect(
  gateway: FpxGateway,
  providerTxnId: string,
  amount: number,
  payer?: FpxPayerInfo,
): Promise<string> {
  const { redirectUrl } = await gateway.initiate({
    providerTxnId,
    amount: amount.toFixed(2),
    description: "KAEN portal payment",
    returnUrl: `${process.env.APP_WEB_ORIGIN ?? ""}/portal/payments`,
    payer,
  });
  return redirectUrl;
}

/**
 * Initiate an FPX payment for a basket of charges. Creates a PENDING payment +
 * allocations (charges' outstanding UNTOUCHED — the Task 3 callback settles) and
 * returns the gateway redirect URL. Idempotent on (orgId, idempotencyKey): a
 * replay re-mints a redirect for the existing providerTxnId and never creates a
 * second payment.
 *
 * Mirrors submitMultiPaymentService's structure: fast-path replay, basket
 * dedupe, tagged-error → HTTP mapping, and a P2002 race re-fetch.
 */
export async function initiateFpxPaymentService(session: SessionScope, input: FpxInitiateInput): Promise<InitiateResult> {
  // Resolve the gateway BEFORE any DB write: a misconfigured provider (e.g.
  // FPX_PROVIDER=molpay with missing MOLPAY_* env) must throw here, not strand
  // a fresh pending Payment row behind a mid-initiate failure.
  const gateway = getFpxGateway();
  const payer = await findPartyBillingInfo(session.orgId, session.partyId);

  // Fast idempotent replay (optimization; the @@unique on idempotencyKey + the
  // P2002 catch below are the atomic source of truth).
  const prior = await findFpxPaymentByIdempotencyKey(session.orgId, input.idempotencyKey);
  if (prior) {
    const redirectUrl = await gatewayRedirect(gateway, prior.providerTxnId, prior.amount, payer);
    return { ok: true, status: 200, data: { redirectUrl, providerTxnId: prior.providerTxnId, paymentId: prior.id } };
  }

  // The tenant is back and starting another payment — the same moment the old
  // code used to EXPIRE their in-flight rows on a 30-minute timer. The trigger
  // was fine; the action was not. On FPX a pending transaction is not a stalled
  // one (B2B answers "pending" first and is resolved later by a human approver,
  // with no published maximum), so we now ASK the gateway instead of assuming.
  //
  // Fire-and-forget on purpose: the tenant is waiting on a redirect, and a slow
  // gateway must never delay their checkout. It also must never fail their
  // payment, hence the swallowed rejection.
  //
  // This is a self-heal, not the guarantee. The scheduled sweep
  // (`cron/fpx-requery.ts`) is what covers tenants who never come back — without
  // it armed, THIS is the only thing that ever resolves an abandoned attempt.
  void requeryTenantStaleFpx({
    organizationId: session.orgId,
    partyId: session.partyId,
  }).catch((err) => console.warn("[fpx-initiate] opportunistic requery failed", err));

  // A charge may appear only once per basket (else it collides on the
  // allocation @@unique key).
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.chargeId)) return { ok: false, status: 400, error: "Each charge may appear only once." };
    seen.add(a.chargeId);
  }

  const lines = input.allocations.map((a) => ({
    chargeId: a.chargeId,
    allocatedAmount: Number(a.allocatedAmount),
    prorateRatio: a.prorateRatio ?? null,
  }));

  const paymentNumber = genPaymentNumber();
  // Hyphen-less: Fiuu's orderid field is string(32) and a dashed UUID is 36.
  const providerTxnId = crypto.randomUUID().replace(/-/g, "");

  try {
    const created = await initiateFpxPaymentTx({
      organizationId: session.orgId, partyId: session.partyId, actorUserId: session.userId,
      provider: gateway.provider,
      paymentNumber, providerTxnId, idempotencyKey: input.idempotencyKey, lines,
    });
    const redirectUrl = await gatewayRedirect(gateway, created.providerTxnId, created.amount, payer);
    return { ok: true, status: 200, data: { redirectUrl, providerTxnId: created.providerTxnId, paymentId: created.id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findFpxPaymentByIdempotencyKey(session.orgId, input.idempotencyKey);
      if (existing) {
        const redirectUrl = await gatewayRedirect(gateway, existing.providerTxnId, existing.amount, payer);
        return { ok: true, status: 200, data: { redirectUrl, providerTxnId: existing.providerTxnId, paymentId: existing.id } };
      }
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg === "CHARGE_NOT_FOUND") return { ok: false, status: 404, error: "Charge not found" };
    if (msg === "CHARGE_NOT_PAYABLE") return { ok: false, status: 400, error: "A selected charge is not payable" };
    if (msg === "ALLOC_EXCEEDS_OUTSTANDING") return { ok: false, status: 400, error: "An amount exceeds the charge's outstanding balance" };
    if (msg === "ALLOC_BELOW_OUTSTANDING") return { ok: false, status: 400, error: "Each charge must be paid in full" };
    if (msg === "BAD_AMOUNT") return { ok: false, status: 400, error: "Amounts must be positive" };
    // The shared validator's double-submit guard. Reachable here as the
    // slip-then-FPX ordering: the tenant submitted a transfer slip that an
    // admin hasn't verified yet, then tried to pay the same charge by FPX —
    // which would take the money for real, a second time. The sweep above
    // already cleared their own abandoned FPX rows, so anything still blocking
    // is a live claim on this charge.
    // Reachable only as slip-then-FPX now — an in-flight FPX attempt no longer
    // blocks anything (see AWAITING_VERIFICATION_WHERE). No email is promised:
    // nothing sends the payer one. See portal.payments.service.ts.
    if (msg === "CHARGE_PENDING_VERIFICATION") {
      return {
        ok: false,
        status: 409,
        error: "You've already submitted a bank transfer for one of these charges and we're still checking it. Please don't pay again — you can follow its status under Payments.",
      };
    }
    throw err;
  }
}
