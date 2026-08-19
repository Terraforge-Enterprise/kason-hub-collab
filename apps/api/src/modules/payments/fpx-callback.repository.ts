import { getDb } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { FPX_PROVIDER_IDS } from "../../lib/fpx/providers";

/**
 * Repository helpers for the FPX callback webhook (Task 3 — settle).
 *
 * The callback carries NO session/org — `providerTxnId` is a globally-unique
 * randomUUID minted at initiate, so the payment row is resolved by it alone and
 * the org is read back off the row.
 */

export type FpxCallbackPaymentRow = {
  id: string;
  organizationId: string;
  status: string;
  gatewayStatus: string | null;
  /** Fiuu's own transaction id, once we've seen a message carrying it. */
  providerTranId: string | null;
  /** What WE recorded as owed — the yardstick a gateway claim is checked against. */
  amount: string;
  currency: string;
};

/**
 * Resolve the FPX-initiated payment for a callback's providerTxnId
 * (org-agnostic). Matches ALL known FPX providers, not just the active one — a
 * provider swap must never strand a row the previous provider minted mid-flight.
 */
export async function findPaymentByProviderTxnId(
  providerTxnId: string,
): Promise<FpxCallbackPaymentRow | null> {
  if (!providerTxnId) return null;
  const db = getDb();
  const row = await db.payment.findFirst({
    where: { provider: { in: [...FPX_PROVIDER_IDS] }, providerTxnId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      gatewayStatus: true,
      providerTranId: true,
      amount: true,
      currency: true,
    },
  });
  if (!row) return null;
  // 2dp string, matching the exact format the amount was signed with at initiate.
  return { ...row, amount: Number(row.amount).toFixed(2) };
}

/**
 * Payments the gateway confirmed but that we could not apply automatically —
 * the `needs_reconciliation` queue.
 *
 * Every row here means the payer's bank almost certainly took the money and our
 * books do not yet reflect it, so this list is a liability, not a report. Oldest
 * first: the FPX merchant agreement gives a payer 60 days to demand funds back,
 * and the clock on each row started when the bank debited them.
 */
export async function listPaymentsNeedingReconciliation(orgId: string) {
  const db = getDb();
  const rows = await db.payment.findMany({
    where: { organizationId: orgId, status: "needs_reconciliation" },
    select: {
      id: true,
      paymentNumber: true,
      amount: true,
      currency: true,
      createdAt: true,
      gatewayStatus: true,
      providerTranId: true,
      party: { select: { displayName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    paymentNumber: r.paymentNumber,
    partyName: r.party.displayName,
    amount: Number(r.amount.toString()),
    currency: r.currency,
    createdAt: r.createdAt.toISOString(),
    ageHours: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 3_600_000)),
    /** How the payment had been closed off before the gateway confirmed it. */
    closedBy: r.gatewayStatus === "cancelled" ? ("admin" as const) : ("gateway" as const),
    providerTranId: r.providerTranId,
  }));
}

/**
 * Resolve one queued payment.
 *
 * `settle` returns it to `pending_approval` so the ordinary settle path can
 * apply it — deliberately reusing that path rather than writing money here.
 * `dismiss` returns it to `expired`, for the case where an admin has checked the
 * bank and the money genuinely did not arrive.
 *
 * Both are conditional on the row still being queued, so two admins working the
 * list cannot both act on one payment. The reason is required and audited: this
 * is a human overriding an automated decision about money, which is exactly the
 * thing an auditor will ask to see the justification for.
 */
export async function resolveNeedsReconciliationTx(params: {
  organizationId: string;
  paymentId: string;
  action: "settle" | "dismiss";
  reason: string;
  actorUserId: string;
  actorRole: string;
}): Promise<boolean> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const res = await tx.payment.updateMany({
      where: {
        id: params.paymentId,
        organizationId: params.organizationId,
        status: "needs_reconciliation",
      },
      data:
        params.action === "settle"
          ? { status: "pending_approval", gatewayStatus: "pending" }
          // `gatewayStatus: "dismissed"` — NOT "cancelled". The gateway keeps
          // re-delivering the same success (3 attempts over ~45 minutes), and
          // every delivery re-reads this row. A "cancelled" row is indistinguish-
          // able from an admin cancel that has never been reviewed, so the next
          // delivery would re-park it and raise a second notification — silently
          // reversing an audited human decision that the money did not arrive.
          // "dismissed" is the marker the callback path treats as final.
          : { status: "expired", gatewayStatus: "dismissed" },
    });
    if (res.count === 0) return false;

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: `payment.fpx_reconciliation_${params.action}`,
      entityType: "Payment",
      entityId: params.paymentId,
      meta: { reason: params.reason },
    });
    return true;
  });
}

/**
 * Put a payment BACK in the reconciliation queue after an attempted settle
 * failed.
 *
 * `resolveNeedsReconciliationTx` commits the status change in its own
 * transaction before the settle is attempted, so a settle that fails (typically
 * because a charge's outstanding drifted while the payment sat in the queue)
 * would otherwise strand the row at `pending_approval`: gone from the liability
 * list, and surfaced only in the in-flight FPX panel whose only action is
 * Cancel. The money the bank took would stop being tracked precisely when we
 * learned it needs attention.
 *
 * Records WHY, so the next person to open the queue sees what stopped it rather
 * than finding the same item back with no explanation.
 */
export async function returnToReconciliationQueueTx(params: {
  organizationId: string;
  paymentId: string;
  actorUserId: string;
  actorRole: string;
  error: string;
}): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const res = await tx.payment.updateMany({
      where: {
        id: params.paymentId,
        organizationId: params.organizationId,
        // Only if the resolve attempt's own write is still the current state; a
        // concurrent callback may legitimately have settled it in between.
        status: "pending_approval",
      },
      data: { status: "needs_reconciliation" },
    });
    if (res.count === 0) return;

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.fpx_reconciliation_settle_failed",
      entityType: "Payment",
      entityId: params.paymentId,
      meta: { needsReconciliation: true, error: params.error },
    });
  });
}

/**
 * In-flight FPX payments the scheduled sweep should ask the gateway about.
 *
 * Cross-organisation by design — this runs as a system job, not inside a session.
 * Oldest first, so the most-stuck payment is asked about before a backlog eats
 * the run's budget.
 *
 * `olderThan` is a GRACE period, not an expiry: it only avoids querying a
 * transaction the payer is probably still looking at. Nothing here terminates
 * anything; only the gateway's own answer can do that.
 */
export async function findPendingFpxPaymentsForRequery(params: {
  olderThan: Date;
  limit: number;
  /** Narrow to one tenant — the opportunistic heal on re-initiate. */
  organizationId?: string;
  partyId?: string;
}): Promise<
  { id: string; organizationId: string; providerTxnId: string; providerTranId: string | null; amount: string }[]
> {
  const db = getDb();
  const rows = await db.payment.findMany({
    where: {
      provider: { in: [...FPX_PROVIDER_IDS] },
      status: "pending_approval",
      gatewayStatus: "pending",
      providerTxnId: { not: null },
      createdAt: { lt: params.olderThan },
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.partyId ? { partyId: params.partyId } : {}),
    },
    select: { id: true, organizationId: true, providerTxnId: true, providerTranId: true, amount: true },
    orderBy: { createdAt: "asc" },
    take: params.limit,
  });
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organizationId,
    providerTxnId: r.providerTxnId as string,
    providerTranId: r.providerTranId,
    // The checksum on a requery is computed over the EXACT 2dp amount string, so
    // this must be formatted the same way the initiate signed it.
    amount: Number(r.amount).toFixed(2),
  }));
}

/**
 * Stamp the gateway's own transaction id the FIRST time we see one, and never
 * overwrite it. Fire-and-forget: a failure here must never block settling a
 * payment the bank has already taken.
 *
 * Write-once because the id is our only long-window requery key (180 days by
 * transaction id vs 7 by order id) and a later message carrying a different
 * value would mean something is wrong that silently clobbering would hide.
 */
export async function persistProviderTranId(paymentId: string, providerTranId: string): Promise<void> {
  const db = getDb();
  await db.payment.updateMany({
    where: { id: paymentId, providerTranId: null },
    data: { providerTranId },
  });
}

/**
 * Flip a payment our OWN timer expired back to `pending_approval` so the normal
 * settle path can apply it. Returns false if the row is no longer the sweep-
 * expired shape we read a moment ago (a concurrent callback or an admin got
 * there first) — the caller re-reads rather than forcing it.
 *
 * Conditional on `gatewayStatus: "expired"`, which is what the automatic sweep
 * writes. An admin cancel writes "cancelled" and is deliberately NOT revivable
 * here: overriding a human's decision without review is the one thing this
 * whole path exists to avoid.
 *
 * `gatewayStatus` returns to "pending" — honest, since Fiuu never knew we
 * expired it (there is no FPX void API), and it puts the row back in the
 * in-flight admin panel if the settle that follows then fails.
 */
export async function reviveSweptFpxPaymentTx(params: {
  paymentId: string;
  organizationId: string;
  actorUserId: string;
  actorRole: string;
}): Promise<boolean> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const res = await tx.payment.updateMany({
      where: {
        id: params.paymentId,
        organizationId: params.organizationId,
        status: "expired",
        gatewayStatus: "expired",
      },
      data: { status: "pending_approval", gatewayStatus: "pending" },
    });
    if (res.count === 0) return false;

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.fpx_revived_for_late_settlement",
      entityType: "Payment",
      entityId: params.paymentId,
      meta: {
        reason: "signed gateway success arrived after our own timer expired this payment",
        from: { status: "expired", gatewayStatus: "expired" },
        to: { status: "pending_approval", gatewayStatus: "pending" },
      },
    });
    return true;
  });
}

/**
 * Park a signed gateway SUCCESS that we must not apply automatically — the row
 * was cancelled by a human, or already failed at the gateway. The bank has very
 * likely debited the payer, so this can never be dropped; it becomes an item a
 * person resolves.
 *
 * Writes three durable artefacts, because the failure this replaces left only a
 * `console.error`: the status itself (queryable), an audit row (what happened),
 * and a notification (someone finds out without being told to look).
 *
 * Charges are UNTOUCHED — `needs_reconciliation` is explicitly not cash.
 *
 * @returns true when this call actually parked the row; false when the
 * status-guarded claim matched nothing — someone else got there first, or the
 * caller's `priorStatus` was stale. Returned rather than swallowed because a
 * caller that reports "parked" for a park that never landed leaves money at the
 * bank with no trace, which is the exact failure this helper exists to prevent.
 */
export async function holdForReconciliationTx(params: {
  paymentId: string;
  organizationId: string;
  actorUserId: string;
  actorRole: string;
  /** The state the payment was in when the late success arrived. */
  priorStatus: string;
  priorGatewayStatus: string | null;
  paymentNumber?: string;
  /** Why it could not be applied — e.g. a figure that did not match ours. */
  detail?: string;
}): Promise<boolean> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // Org-scoped and status-guarded, like its siblings. The browser-return route
    // and the server notification both run this handler with the same body, so
    // double-delivery is the NORMAL case, not an exotic race — and an
    // unconditional update let both pass the caller's stale status read and each
    // raise a notification for one payment. It could also overwrite a resolution
    // an admin had just committed.
    const claimed = await tx.payment.updateMany({
      where: {
        id: params.paymentId,
        organizationId: params.organizationId,
        status: params.priorStatus,
      },
      data: { status: "needs_reconciliation" },
    });
    // Someone else got there first — no second notification, no second audit row.
    // Reported to the caller so a park that did not land is never announced as one.
    if (claimed.count === 0) return false;

    await tx.notification.create({
      data: {
        organizationId: params.organizationId,
        domain: "finance",
        title: "Payment needs reconciliation",
        body: params.detail
          ? `The bank confirmed a payment but the details don't match what we recorded (${params.detail}). ` +
            `It has NOT been applied and NOT been written off — someone needs to check the bank and decide. ` +
            `Nothing has been applied to any charge.`
          : `The bank confirmed a payment that was already ${params.priorStatus === "failed" ? "marked failed" : "cancelled"}. ` +
            `The payer has most likely been debited, so this has NOT been written off — it is waiting for someone to decide ` +
            `whether to apply it or refund it. Nothing has been applied to any charge.`,
        actionUrl: "/billing/payments",
      },
    });

    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.fpx_late_settlement_held",
      entityType: "Payment",
      entityId: params.paymentId,
      meta: {
        needsReconciliation: true,
        reason:
          params.detail ??
          "signed gateway success arrived for a payment that was already terminal by human or gateway decision",
        from: { status: params.priorStatus, gatewayStatus: params.priorGatewayStatus },
        to: { status: "needs_reconciliation" },
      },
    });
    return true;
  });
}

// NOTE: the session-less system actor is resolved via the EXISTING
// `resolveSystemActor(orgId)` in `../billing/auto-draft.repository` (the same
// helper the auto-draft cron uses) — it returns a REAL admin `User`
// `{actorUserId, actorRole}` so both postPaymentTx's audit AND the owner-ledger
// sync's audit satisfy the `AuditLog.actorUserId` FK. The owner-ledger
// `SYNC_ACTOR_ID` sentinel is NOT reusable here: it only stamps the non-FK
// `OwnerLedgerEntry.createdById/updatedById`, never the audit actor.

/**
 * Stamp gatewayStatus="success" after a settle. Plain update by id (the
 * authoritative idempotency guard is postPaymentTx's status transition, not this
 * field) — a failed write here is cosmetic, never a double-settle.
 */
export async function setFpxGatewaySuccess(paymentId: string): Promise<void> {
  const db = getDb();
  await db.payment.update({ where: { id: paymentId }, data: { gatewayStatus: "success" } });
}

/**
 * Mark a pending FPX payment FAILED from a signed "failed" callback. Sets
 * status + gatewayStatus to "failed" and records `payment.fpx_failed`, atomically.
 * Charges are NEVER touched (the pending payment never settled any).
 *
 * Org-scoped and status-guarded INSIDE the transaction, like every sibling here
 * (`reviveSweptFpxPaymentTx`, `holdForReconciliationTx`,
 * `resolveNeedsReconciliationTx`, `returnToReconciliationQueueTx`). The caller
 * does check `status === "pending_approval"` — but outside the transaction, with
 * a `resolveSystemActor` round trip in between, so a concurrent settle can land
 * in that window. Writing `failed` over a row whose allocations are already
 * applied would be the worst outcome in this file: `CASH_ALLOCATION_WHERE` keys
 * on `payment.status === "posted"`, so the collected cash would vanish from
 * every cash reader (owner ledger, `amountPaid`, bills-grid settlement, R5)
 * while the tenant's debt stayed cleared. The predicate is exactly what the
 * caller has just asserted, so it can only ever match FEWER rows in a race —
 * never change the uncontended outcome.
 */
export async function failFpxPaymentTx(params: {
  paymentId: string;
  organizationId: string;
  actorUserId: string;
  actorRole: string;
}): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: {
        id: params.paymentId,
        organizationId: params.organizationId,
        status: "pending_approval",
      },
      data: { status: "failed", gatewayStatus: "failed" },
    });
    // Someone else moved it first — do not audit a transition that did not happen.
    if (claimed.count === 0) return;
    await recordAudit(tx, {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "payment.fpx_failed",
      entityType: "Payment",
      entityId: params.paymentId,
    });
  });
}

// REMOVED: `flagFpxReconcileTx`. It recorded a `payment.fpx_settle_failed`
// AuditLog row and NOTHING else — no status change, no notification — so a
// payment the bank had taken money for stayed `pending_approval`: absent from
// `listPaymentsNeedingReconciliation`, permanently matched by
// `findPendingFpxPaymentsForRequery`, and reachable by an admin only through
// Cancel (writing the money off). `meta.needsReconciliation: true` was read by
// nothing. The settle-failure branch now calls `holdForReconciliationTx` above,
// which is what the figures-mismatch branch always did.

