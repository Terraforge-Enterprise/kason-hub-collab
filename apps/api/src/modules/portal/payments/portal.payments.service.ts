import { Prisma } from "@kason/db";
import type { PortalPayInput } from "@kason/shared";
import {
  findPaymentByIdempotencyKey,
  submitMultiPaymentTx,
} from "./portal.payments.repository";
import { isOwnedPaymentSlipKey } from "./slip-storage";
import { objectExists } from "../../../lib/storage";

type SessionScope = { partyId: string; orgId: string; userId: string };

export async function submitMultiPaymentService(session: SessionScope, input: PortalPayInput) {
  // Fast idempotent replay (optimization only; the @@unique on idempotencyKey
  // + the P2002 catch below are the atomic source of truth).
  const prior = await findPaymentByIdempotencyKey(session.orgId, input.idempotencyKey);
  if (prior) return { ok: true as const, status: 200, data: prior };

  // A charge may appear only once per basket (else it collides on the
  // allocation @@unique key).
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.chargeId)) return { ok: false as const, status: 400, error: "Each charge may appear only once." };
    seen.add(a.chargeId);
  }

  // The slip keys arrive from the client. Zod checked their SHAPE; this checks
  // their OWNERSHIP — the prefix encodes org + party, so a key that isn't this
  // tenant's is a cross-tenant read attempt (proof-urls signs whatever
  // attachmentKeys holds), not a validation slip. 403, and never persisted.
  const attachmentKeys = input.attachmentKeys ?? [];
  if (attachmentKeys.some((k) => !isOwnedPaymentSlipKey(k, session.orgId, session.partyId))) {
    return { ok: false as const, status: 403, error: "Transfer slip does not belong to this account." };
  }

  // …and the object has to actually BE there. The prefix check above proves the
  // key was minted for this tenant, not that anything was uploaded against it:
  // a client can call /slip-upload-url, skip the PUT, and submit the key. That
  // produces a payment whose slip silently 404s at review time, which the admin
  // panel renders as "Slip unavailable — refresh to try again" — a storage
  // hiccup, not the slipless submission it really is. Fail at submit instead,
  // where the tenant can still fix it.
  for (const key of attachmentKeys) {
    if (!(await objectExists(key))) {
      return {
        ok: false as const,
        status: 400,
        error: "We didn't receive your transfer slip. Please attach it again.",
      };
    }
  }

  // NO lazy expiry here any more — see the note in fpx-initiate.service.ts.
  // The FPX-then-slip ordering this used to unblock is handled at the guard
  // itself: AWAITING_VERIFICATION_WHERE matches only claims awaiting a HUMAN, so
  // a tenant's in-flight bank redirect no longer blocks them paying by transfer.
  // Terminating a payment on age alone is never safe on this rail.

  const lines = input.allocations.map((a) => {
    const n = Number(a.allocatedAmount);
    return { chargeId: a.chargeId, allocatedAmount: n, prorateRatio: a.prorateRatio ?? null };
  });

  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const paymentNumber = `PAY-${ts}-${rand}`.toUpperCase();

  try {
    const data = await submitMultiPaymentTx({
      organizationId: session.orgId, partyId: session.partyId, actorUserId: session.userId, paymentNumber,
      idempotencyKey: input.idempotencyKey, paymentMethod: input.paymentMethod,
      referenceNumber: input.referenceNumber, notes: input.notes ?? null,
      attachmentKeys, lines,
    });
    return { ok: true as const, status: 201, data };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findPaymentByIdempotencyKey(session.orgId, input.idempotencyKey);
      if (existing) return { ok: true as const, status: 200, data: existing };
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg === "CHARGE_NOT_FOUND") return { ok: false as const, status: 404, error: "Charge not found" };
    if (msg === "CHARGE_NOT_PAYABLE") return { ok: false as const, status: 400, error: "A selected charge is not payable" };
    if (msg === "ALLOC_EXCEEDS_OUTSTANDING") return { ok: false as const, status: 400, error: "An amount exceeds the charge's outstanding balance" };
    if (msg === "ALLOC_BELOW_OUTSTANDING") return { ok: false as const, status: 400, error: "Each charge must be paid in full" };
    if (msg === "BAD_AMOUNT") return { ok: false as const, status: 400, error: "Amounts must be positive" };
    // 409, not 400: nothing about the request is malformed — it conflicts with
    // a payment already awaiting review. The wording has to stop the tenant
    // paying twice, so it says the earlier payment is still being checked
    // rather than implying this one failed.
    // No email is promised here on purpose: nothing in this codebase sends the
    // payer a notification on approve OR reject (the submit-time Notification
    // row carries no userId — it is the org-wide ADMIN alert). Promising one
    // would leave a blocked tenant waiting for a message that never arrives,
    // which is exactly how someone ends up paying twice.
    if (msg === "CHARGE_PENDING_VERIFICATION") {
      return {
        ok: false as const,
        status: 409,
        error: "You've already submitted a payment for one of these charges and we're still checking it. Please don't pay again — you can follow its status under Payments.",
      };
    }
    throw err;
  }
}
