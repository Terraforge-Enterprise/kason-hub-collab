import { getFpxGateway } from "../../lib/fpx";
import { applyVerifiedFpxOutcome, type FpxCallbackResponse } from "./fpx-callback.service";
import { findPendingFpxPaymentsForRequery } from "./fpx-callback.repository";

/**
 * Scheduled FPX requery sweep — the ACTIVE half of settlement.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Until this job, the system could only ever be TOLD what happened to a payment.
 * Fiuu delivers a callback 3 times at 15-minute intervals and then stops
 * permanently, so a notification lost to a deploy, an outage, or a
 * misconfigured URL was lost for good — with the payer debited and nothing on
 * our side to find it by. Fiuu's own guidance is to poll pending transactions
 * every half hour rather than time them out locally, and this is that poll.
 *
 * ── What it may and may not do ───────────────────────────────────────────────
 * It NEVER decides anything itself. Every outcome it applies came from the
 * gateway and was checksum-verified, and it routes them through
 * `applyVerifiedFpxOutcome` — the exact function an inbound callback uses — so a
 * payment cannot settle differently depending on which channel reached us first.
 *
 * Anything short of a verified answer (transport failure, unparseable reply, no
 * record, an adapter that cannot query) leaves the payment EXACTLY as it was.
 * "We could not find out" is not "it failed", and conflating the two is how a
 * live payment gets killed while the payer's money is in flight.
 *
 * ── Rate limiting ────────────────────────────────────────────────────────────
 * Fiuu publishes per-endpoint ceilings (30 req/s for q_by_tid, 10 for q_by_oid)
 * and warns that "excessive and rapid API calls will be blocked without prior
 * notice", alongside a recommended cadence of one requery per pending
 * transaction every half hour. The 5-second spacing below is deliberately far
 * more conservative than any published limit — it is a self-imposed floor, not
 * a documented one, chosen because the penalty for being wrong is an IP ban that
 * takes the production API host offline for every tenant at once.
 */

export type FpxRequerySweepResult = {
  /** Rows the sweep looked at. */
  checked: number;
  /**
   * Gateway said success AND the settle path reported it applied the money.
   *
   * Deliberately narrow. A payment a concurrent callback had already settled
   * does NOT count here — it lands in `unresolved`, because this sweep did not
   * do it. That is an under-count on the most common benign outcome in a sweep
   * that races callbacks, and it is the right direction to be wrong in: over-
   * reporting recovered money is the failure that matters.
   */
  settled: number;
  /** Gateway said failed → payment marked failed. */
  failed: number;
  /**
   * The gateway's answer could not be applied automatically and the payment was
   * queued for a human — a figure that did not match ours, or a row a person had
   * already closed off. Counted apart from `settled` because it is money the
   * bank took that our books still do not show.
   */
  parked: number;
  /** Gateway said still pending → deliberately untouched. */
  stillPending: number;
  /**
   * We could not get a verified answer. Untouched, and counted separately: a
   * rising number here means the gateway integration is degraded, which is a
   * very different problem from "payers are abandoning checkouts".
   */
  unresolved: number;
};

/**
 * Grace period before a pending payment is worth asking about. Not an expiry —
 * it only avoids querying a transaction the payer is probably still staring at.
 * Matches Fiuu's own suggested requery cadence.
 */
const DEFAULT_GRACE_MINUTES = 30;

/** Per-run ceiling, so one backlog cannot run for hours. */
const DEFAULT_BATCH_LIMIT = 50;

/** Fiuu's documented floor: one query per five seconds, enforced by IP ban. */
const MIN_QUERY_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort requery of ONE tenant's own stale in-flight attempts, triggered by
 * that tenant starting another payment.
 *
 * The old code expired those rows on a 30-minute timer at exactly this moment.
 * That was wrong — on FPX a pending transaction is not a stalled one — but
 * deleting it left nothing at all resolving them unless the scheduled sweep is
 * armed, which it is not by default. A tenant would then watch "Waiting for your
 * bank" sit there forever: the very complaint this work started from.
 *
 * So the trigger is kept and the ACTION is corrected — ask the gateway instead of
 * assuming. Same moment, opposite epistemics.
 *
 * Deliberately capped and fire-and-forget at the call site: this runs while a
 * tenant is waiting on a redirect, and a slow gateway must never delay their
 * checkout. It is a self-heal, not a guarantee — the scheduled sweep remains the
 * mechanism that covers tenants who never come back at all.
 */
export async function requeryTenantStaleFpx(params: {
  organizationId: string;
  partyId: string;
  graceMinutes?: number;
  limit?: number;
}): Promise<void> {
  const candidates = await findPendingFpxPaymentsForRequery({
    olderThan: new Date(Date.now() - (params.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000),
    limit: params.limit ?? 3,
    organizationId: params.organizationId,
    partyId: params.partyId,
  });

  const gateway = getFpxGateway();
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (i > 0) await sleep(MIN_QUERY_INTERVAL_MS);
    try {
      const answer = await gateway.queryStatus({
        providerTxnId: p.providerTxnId,
        providerTranId: p.providerTranId ?? undefined,
        amount: p.amount,
      });
      if (!answer.ok || answer.status === "pending") continue;
      await applyVerifiedFpxOutcome({
        providerTxnId: p.providerTxnId,
        providerTranId: answer.providerTranId ?? p.providerTranId ?? undefined,
        // Carried through so the poll gets the SAME amount check as the push.
        // Omitting them skipped the guard entirely on this channel — and this is
        // the channel that only just started working, so the hole arrived with
        // the fix that made it reachable.
        amount: answer.amount,
        currency: answer.currency,
        status: answer.status,
      });
    } catch (err) {
      // Never surfaces to the tenant — their new payment must proceed regardless.
      console.warn("[fpx-requery] opportunistic heal failed", { paymentId: p.id, err });
    }
  }
}

export async function runFpxRequerySweep(opts?: {
  graceMinutes?: number;
  limit?: number;
  /** Test seam. Never lower this against a real gateway. */
  queryIntervalMs?: number;
}): Promise<FpxRequerySweepResult> {
  const graceMinutes = opts?.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const limit = opts?.limit ?? DEFAULT_BATCH_LIMIT;
  const intervalMs = opts?.queryIntervalMs ?? MIN_QUERY_INTERVAL_MS;

  const result: FpxRequerySweepResult = {
    checked: 0,
    settled: 0,
    failed: 0,
    parked: 0,
    stillPending: 0,
    unresolved: 0,
  };

  // Resolve the gateway BEFORE touching the database: a misconfigured provider
  // must fail the run loudly rather than silently sweep nothing.
  const gateway = getFpxGateway();

  const candidates = await findPendingFpxPaymentsForRequery({
    olderThan: new Date(Date.now() - graceMinutes * 60_000),
    limit,
  });
  if (candidates.length === 0) return result;

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    // Space the calls out. Before each query except the first, so a single-row
    // run costs nothing.
    if (i > 0) await sleep(intervalMs);

    result.checked++;

    let answer;
    try {
      answer = await gateway.queryStatus({
        providerTxnId: p.providerTxnId,
        providerTranId: p.providerTranId ?? undefined,
        amount: p.amount,
      });
    } catch (err) {
      // An adapter throwing is the same class of event as a transport failure:
      // we learned nothing, so we change nothing.
      result.unresolved++;
      console.error("[fpx-requery] adapter threw", { paymentId: p.id, err });
      continue;
    }

    if (!answer.ok) {
      result.unresolved++;
      // `unsupported` is expected on the mock adapter and is not noteworthy.
      if (answer.reason !== "unsupported") {
        console.warn("[fpx-requery] no verified answer — payment left untouched", {
          paymentId: p.id,
          reason: answer.reason,
          detail: answer.detail,
        });
      }
      continue;
    }

    if (answer.status === "pending") {
      result.stillPending++;
      continue;
    }

    // Verified terminal answer → the SAME path an inbound callback takes.
    try {
      const applied: FpxCallbackResponse = await applyVerifiedFpxOutcome({
        providerTxnId: p.providerTxnId,
        providerTranId: answer.providerTranId ?? p.providerTranId ?? undefined,
        // Carried through so the poll gets the SAME amount check as the push.
        // Omitting them skipped the guard entirely on this channel — and this is
        // the channel that only just started working, so the hole arrived with
        // the fix that made it reachable.
        amount: answer.amount,
        currency: answer.currency,
        status: answer.status,
      });
      // Keyed on what the handler REPORTS it did, never on "it returned ok".
      // `ok: true` covers a dozen deliberate no-ops — already parked, already
      // dismissed, no admin actor, every idempotent replay — so inferring
      // "settled" from it counted untouched payments as recovered money.
      if (applied.applied === "settled") result.settled++;
      else if (applied.applied === "failed") result.failed++;
      else if (applied.applied === "parked") result.parked++;
      else {
        result.unresolved++;
        console.warn("[fpx-requery] verified answer changed nothing", {
          paymentId: p.id,
          gatewaySaid: answer.status,
          httpStatus: applied.status,
        });
      }
    } catch (err) {
      // One payment failing to apply must not abandon the rest of the batch —
      // especially since the ones behind it may be the ones owed money.
      result.unresolved++;
      console.error("[fpx-requery] could not apply a verified outcome", {
        paymentId: p.id,
        status: answer.status,
        err,
      });
    }
  }

  return result;
}
