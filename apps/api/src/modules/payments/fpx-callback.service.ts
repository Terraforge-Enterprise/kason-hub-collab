import { getFpxGateway } from "../../lib/fpx";
import { resolveSystemActor } from "../billing/auto-draft.repository";
import { postPaymentService } from "./payments.service";
import {
  findPaymentByProviderTxnId,
  setFpxGatewaySuccess,
  failFpxPaymentTx,
  persistProviderTranId,
  reviveSweptFpxPaymentTx,
  holdForReconciliationTx,
} from "./fpx-callback.repository";

/**
 * FPX callback (settle) — the ONLY place a portal FPX payment actually settles.
 *
 * A signed gateway callback verifies its HMAC, resolves the pending payment by
 * its globally-unique providerTxnId, and — on "success" — settles it through the
 * EXISTING `postPaymentService` (applies allocations → reduces outstanding →
 * marks charges paid/partial → notifies owners + syncs the owner-ledger). It is
 * money-safe and idempotent: a doubled callback settles EXACTLY once, and an
 * unverified body never moves money.
 *
 * The callback has no session. `AuditLog.actorUserId` is FK-constrained to
 * `User`, so — exactly as the auto-draft cron does — the action is attributed to
 * the org's admin via `resolveSystemActor(orgId)` → `{actorUserId, actorRole}`.
 * If the org has NO admin we cannot write the FK-constrained audit: ack the
 * gateway (200) + log, leaving the payment pending for manual reconciliation
 * (never throw away the gateway's money event, never mark gatewayStatus success).
 */

export type FpxCallbackResponse = {
  ok: boolean;
  status: number;
  /**
   * What actually HAPPENED to the payment, as distinct from whether the HTTP
   * exchange succeeded.
   *
   * `ok: true` covers a dozen branches that deliberately change nothing —
   * already-parked, already-dismissed, no admin actor, and every idempotent
   * no-op — because the gateway should stop retrying all of them. A caller that
   * infers "settled" from `ok` therefore reports work that never happened, which
   * is exactly what the requery sweep was doing: its five counters are the job's
   * only output, and "settled: 3" for three untouched payments is worse than no
   * number at all.
   *
   * Absent ⇒ nothing changed.
   *
   * `settled` vs `already_settled` is the same distinction one level down, and
   * it exists because two consumers need different answers:
   *   - the browser-return banner treats BOTH as "received" — the payer's money
   *     is applied either way, and Fiuu's server-to-server notify usually beats
   *     their browser back, so the already-settled case is the NORMAL path for a
   *     successful payment;
   *   - the requery sweep counts ONLY `settled`, because its counters report what
   *     THAT SWEEP recovered. Folding the two together made `settled: 3`
   *     indistinguishable from "three payments this sweep rescued".
   */
  applied?: "settled" | "already_settled" | "failed" | "parked";
};

/**
 * A gateway outcome we have already established is genuine — either because its
 * signature verified on an inbound callback, or because WE asked the gateway and
 * verified its reply. Everything downstream of this point is identical for both,
 * which is the entire reason this type exists.
 */
export type VerifiedFpxOutcome = {
  providerTxnId: string;
  providerTranId?: string;
  /**
   * What the gateway says was paid. Absent means "this channel did not tell us"
   * (the mock, and requery replies that omit it) — which is NOT the same as
   * "matches", and is handled explicitly at the comparison below.
   */
  amount?: string;
  currency?: string;
  status: "success" | "failed" | "pending";
};

export async function handleFpxCallbackService(
  rawBody: string,
  signature: string,
): Promise<FpxCallbackResponse> {
  // 1) Signature gate. An unverified body NEVER moves money — and never even
  //    queries (its auth IS the HMAC).
  const v = getFpxGateway().verifyCallback(rawBody, signature);
  if (!v.valid) return { ok: false, status: 400 };

  return applyVerifiedFpxOutcome(v);
}

/**
 * Apply an already-verified gateway outcome to the payment it refers to.
 *
 * Shared verbatim by the inbound callback and the scheduled requery sweep. The
 * two differ ONLY in how they establish that the outcome is genuine — a push
 * proves it with a signature, a poll proves it with a checksum on a reply to a
 * request we made. Once proven, "the bank says this succeeded" means the same
 * thing and must do the same thing, or the two channels drift and a payment
 * settles differently depending on which one happened to reach us first.
 */
/**
 * Does the gateway's amount agree with ours?
 *
 * Compared NUMERICALLY, not by string identity. The guard exists to catch a
 * different VALUE — a RM1 claim against a RM150 charge — and refusing money over
 * `150` vs `150.00` protects nothing while turning every settlement into a
 * manual queue item. The spec says two decimal places, so the tolerance should
 * never actually fire; that is precisely what makes it cheap insurance.
 *
 * An empty string is NEVER agreement, checked explicitly rather than left to
 * `Number("") === 0`. Empty means "claimed to report a figure and reported
 * nothing", which is the one-parameter bypass this guard exists to stop.
 *
 * Why the tolerance is not a loophole: the claimed amount NEVER crosses into the
 * settle. `postPaymentService` takes only a payment id, so the sum applied is
 * always `payment.amount` — our own recorded figure. This comparison decides
 * WHETHER a settle happens, never HOW MUCH, so a sub-cent discrepancy inside the
 * tolerance moves exactly zero money. One cent is still refused.
 *
 * Non-numeric input (`NaN`, `Infinity`, a thousands separator) fails closed and
 * parks. Fiuu's own WooCommerce plugin emits `1,250.00` in places, so that
 * direction is deliberate: park a large payment rather than mis-settle one.
 */
function amountsAgree(claimed: string, recorded: string): boolean {
  if (claimed.trim() === "") return false;
  const a = Number(claimed);
  const b = Number(recorded);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // Half a cent — tighter than any real rounding, looser than string identity.
  return Math.abs(a - b) < 0.005;
}

/**
 * Fiuu's two channels do not name the ringgit the same way.
 *
 * The notify/return CALLBACK POSTs `currency=RM` — the everyday Malaysian
 * symbol. The REQUERY reply, for the very same transaction, answers
 * `Currency: MYR` — the ISO-4217 code, which is also what we send at initiate
 * and what we store on the Payment row.
 *
 * Observed, not theorised: UAT payment PAY-MSX9ZLXR-ZXYY (Fiuu tranID
 * 3955716616, channel FPX_UOB). Its callback said `RM`; a `q_by_tid` requery for
 * the same tranID said `MYR` and `StatCode: 00 / captured`. Comparing those two
 * spellings as different currencies refused a payment the bank had already
 * taken, so every comparison below runs on a canonical form.
 *
 * A fixed alias table, deliberately — NOT a prefix or substring rule. Only the
 * exact token "RM" is the ringgit: "RMB" is the yuan, and "0RM" is a moved
 * signed-field boundary that must still be caught.
 *
 * A Map, not an object literal, so a lookup can only ever find a key we PUT
 * here. `{}["constructor"]` returns a function rather than undefined, and this
 * table is consulted with gateway-controlled input on the path that decides
 * whether a signed body is genuine — `looksLikeACurrencyCode` would have called
 * "constructor" a well-formed currency. Uppercasing happens to dodge every
 * Object.prototype member today (they are all lower-camel), but that is an
 * accident of casing, not a property anyone should have to re-derive before
 * touching this.
 */
const CURRENCY_ALIASES = new Map<string, string>([["RM", "MYR"]]);

function canonicalCurrency(s: string): string {
  const t = s.trim().toUpperCase();
  return CURRENCY_ALIASES.get(t) ?? t;
}

/**
 * Does the gateway's currency agree with ours?
 *
 * Case-INSENSITIVE. `pick()` is already deliberately case-insensitive on field
 * NAMES, with the note that Fiuu's own casing is inconsistent across its
 * documents and SDKs; the identical argument applies to values, and a reply
 * saying `myr` would otherwise park every payment the sweep touched. Case
 * carries no security signal — an attacker gains nothing from `myr` that `MYR`
 * does not already give them.
 *
 * Compared on the canonical form above, so the callback channel's `RM` and the
 * requery channel's `MYR` are the one currency they actually are.
 *
 * Empty is never agreement, for the same reason as the amount.
 */
function currenciesAgree(claimed: string, recorded: string): boolean {
  const c = claimed.trim();
  if (c === "") return false;
  return canonicalCurrency(c) === canonicalCurrency(recorded);
}

/**
 * Could this string be an amount a payment gateway actually sent?
 *
 * Deliberately LOOSE — it is not a validator, it is a "did someone move a field
 * boundary" test. Grouping commas are allowed on purpose: Fiuu's own WooCommerce
 * plugin emits `1,250.00`, and `amountsAgree` already refuses that (it parks
 * rather than mis-settles). Keeping it well-formed here preserves that park.
 */
function looksLikeAGatewayAmount(s: string): boolean {
  const t = s.trim();
  // EMPTY is not a moved boundary — it is a missing figure, and that already has
  // an owner: `amountsAgree` refuses it explicitly and parks, because "claimed to
  // report a figure and reported nothing" is the one-parameter bypass the park
  // exists to surface. Answering "malleated" here would silently swallow it.
  // A re-split that empties one field always fills the other with the leftovers,
  // so the counterpart check still catches it.
  if (t === "") return true;
  return /^\d+(\.\d+)?$/.test(t) || /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t);
}

/**
 * Could this string be a currency a payment gateway actually sent?
 *
 * ISO-4217 is three letters — plus the aliases above, because Fiuu's callback
 * channel really does send the two-letter `RM`. Both are shapes a gateway
 * genuinely emits, so neither is evidence of a moved field boundary.
 *
 * Admitting the alias opens nothing. Every re-split of `amount`+`currency` that
 * could yield an RM-ish token still dies here or on the amount: `150.00R|M`
 * breaks the amount's shape, and `150.0|0RM` leaves `0RM`, which carries a digit
 * and so matches neither the alias table nor the three-letter form.
 *
 * This check being too strict was NOT a harmless over-refusal. `refuseMalleated`
 * deliberately touches nothing and returns 400, so any real mismatch arriving
 * with `currency=RM` — including a genuinely hostile low-amount claim — was
 * silently refused instead of being parked in `needs_reconciliation` where a
 * person would see it. Widening this makes those claims visible again.
 */
function looksLikeACurrencyCode(s: string): boolean {
  const t = s.trim();
  if (t === "") return true; // same reasoning as the amount above
  if (CURRENCY_ALIASES.has(t.toUpperCase())) return true;
  return /^[A-Za-z]{3}$/.test(t);
}

/**
 * A signed body whose amount or currency is structurally impossible.
 *
 * Fiuu's `skey` is an md5 over UNSEPARATED concatenated fields:
 *   key0 = md5(tranID + orderid + status + domain + amount + currency)
 * so moving a field boundary produces a DIFFERENT set of values with a
 * byte-identical signature. `amount=1200.00&currency=MYR` re-splits to
 * `amount=1200.00M&currency=YR` — same bytes into the hash, same `skey`, and it
 * verifies.
 *
 * That matters because Fiuu POSTs the payer's own browser to the Return URL, and
 * that route feeds the body straight into this handler. So every payer holds a
 * validly-signed success body for their own transaction, visible in devtools, on
 * a public unauthenticated route with no CSRF. Replaying it re-split used to park
 * the payment as `needs_reconciliation` — and step 4a then short-circuits every
 * genuine callback that follows, so the real settle could never land. The payer
 * is debited, the charge stays fully outstanding, and `BLOCKS_FURTHER_PAYMENT_WHERE`
 * stops them paying it by any other method until an admin unpicks it by hand.
 * The audit line reads `gateway said "1200.00M"`, which looks like a Fiuu bug —
 * so the natural operator response is to dismiss it and write off money that
 * did arrive.
 *
 * The answer is to touch NOTHING. Not settle (the figures do not match), and
 * crucially not park either — parking is the damage. The row is left exactly as
 * it was, so the genuine callback still settles it normally, and the requery
 * sweep still sees it. `ok:false` rather than an ack, because we genuinely did
 * not handle it: if a real Fiuu message ever landed here, we want it resent.
 */
function refuseMalleated(
  payment: { id: string },
  amount: string | undefined,
  currency: string | undefined,
): FpxCallbackResponse {
  console.error(
    "[fpx-callback] signed body has a structurally impossible amount/currency — " +
      "almost certainly a re-split of the signed field boundary. Refusing to touch the payment: " +
      "NOT settled and NOT parked, so the genuine callback can still settle it.",
    { paymentId: payment.id, amount, currency },
  );
  return { ok: false, status: 400 };
}

/**
 * A signed success whose figures do not match what we recorded. Never settled,
 * never dropped: acked (so the gateway stops retrying a message we HAVE handled)
 * and parked with an explanation, because a correctly-signed claim we cannot
 * reconcile is exactly what a person needs to look at.
 */
async function holdMismatch(
  payment: { id: string; organizationId: string; status: string; gatewayStatus: string | null },
  detail: string,
): Promise<FpxCallbackResponse> {
  console.error("[fpx-callback] verified success does not match the recorded payment", {
    paymentId: payment.id,
    detail,
  });
  const actor = await resolveSystemActor(payment.organizationId);
  if (!actor) return { ok: true, status: 200 };
  await holdForReconciliationTx({
    paymentId: payment.id,
    organizationId: payment.organizationId,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    priorStatus: payment.status,
    priorGatewayStatus: payment.gatewayStatus,
    detail,
  });
  return { ok: true, status: 200, applied: "parked" };
}

export async function applyVerifiedFpxOutcome(
  v: VerifiedFpxOutcome,
): Promise<FpxCallbackResponse> {
  // 1b) PENDING (Fiuu status 22 — the bank flow is still in motion): acknowledge
  //     and change NOTHING about the payment. On FPX-B2B this is the NORMAL first
  //     response for EVERY transaction, resolved later by a human approver, so it
  //     must never be read as a failure: that would mark the payment failed and
  //     strand the later real success AFTER the bank debited the tenant.
  //
  //     The ack is unconditional and deliberately cannot fail. A pending message
  //     carries no money event to lose, whereas a 500 here would consume one of
  //     only three retries Fiuu ever sends — so even a database outage must not
  //     turn this into an error. The tranID capture below is therefore strictly
  //     opportunistic: fully wrapped, and its outcome never reaches the response.
  if (v.status === "pending") {
    if (v.providerTranId) {
      try {
        const row = await findPaymentByProviderTxnId(v.providerTxnId);
        if (row && !row.providerTranId) await persistProviderTranId(row.id, v.providerTranId);
      } catch (err) {
        console.error("[fpx-callback] could not capture providerTranId from a pending callback", { err });
      }
    }
    return { ok: true, status: 200 };
  }

  // 2) Resolve the payment by its globally-unique providerTxnId; the org is read
  //    back off the row (the callback carries none). A throw here is deliberately
  //    NOT caught: on a terminal message we WANT Fiuu to retry rather than ack a
  //    money event we failed to record.
  const payment = await findPaymentByProviderTxnId(v.providerTxnId);
  if (!payment) return { ok: false, status: 404 };

  // 2b) Capture the gateway's own transaction id the first time we see it. It is
  //     our only 180-day requery key (by our order id the history is 7 days) and
  //     is knowable ONLY from a message the gateway sends us — miss it and it is
  //     unrecoverable. Write-once and non-fatal: bookkeeping never blocks a settle.
  if (v.providerTranId && !payment.providerTranId) {
    try {
      await persistProviderTranId(payment.id, v.providerTranId);
    } catch (err) {
      console.error("[fpx-callback] could not persist providerTranId", { paymentId: payment.id, err });
    }
  }

  // 3) Idempotency fast-path — already settled exactly once. (postPaymentTx's
  //    own status transition is the authoritative guard under a true race; this
  //    just avoids redundant work on the common doubled-callback case.)
  if (payment.gatewayStatus === "success" || payment.status === "posted") {
    // The money IS applied — just not by THIS delivery. Reporting nothing here
    // told the common case of successful payers that their payment was still
    // pending: Fiuu's server-to-server notify usually beats the payer's browser
    // back, so the redelivery IS the normal path for a successful payment.
    //
    // `already_settled` rather than `settled`, because the requery sweep counts
    // what IT recovered and must not claim credit for a payment a concurrent
    // callback had already applied.
    return { ok: true, status: 200, applied: "already_settled" };
  }

  // 4) FAILED callback — mark a still-pending payment failed; charges stay
  //    UNTOUCHED (the pending payment never settled any). Any non-pending state
  //    (already failed/void/refunded) is a no-op — never overwrite a terminal row.
  if (v.status === "failed") {
    if (payment.status !== "pending_approval") return { ok: true, status: 200 };
    const actor = await resolveSystemActor(payment.organizationId);
    if (!actor) {
      console.error("[fpx-callback] no admin actor for org — cannot record fpx_failed; left for reconciliation", payment.organizationId);
      return { ok: true, status: 200 };
    }
    await failFpxPaymentTx({
      paymentId: payment.id,
      organizationId: payment.organizationId,
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
    });
    return { ok: true, status: 200, applied: "failed" };
  }

  // ── 4a) Rows a decision has ALREADY been made about ────────────────────────
  //
  // These two short-circuits must come FIRST — ahead of the amount comparison
  // below — because the gateway redelivers the same success up to 3 times over
  // ~45 minutes, and both of these rows will mismatch on every one of them. The
  // mismatch is not incidental: on a parked or dismissed row it is usually the
  // very reason a human looked at it.
  //
  // With the comparison first, each redelivery re-parked the row: a `dismissed`
  // payment (status "expired") satisfied `holdForReconciliationTx`'s
  // `status: priorStatus` guard, so the write landed, the row returned to
  // `needs_reconciliation`, and a fresh notification fired — silently reversing
  // the audited human decision the `dismissed` marker exists to protect. An
  // already-queued row got a duplicate notification the same way.
  if (payment.status === "needs_reconciliation") return { ok: true, status: 200 };
  if (payment.gatewayStatus === "dismissed") return { ok: true, status: 200 };

  // ── 4b) The claim must match what we asked for ─────────────────────────────
  //
  // A verified signature proves the gateway signed this with OUR ACCOUNT's
  // secret. It does not prove the figures are ours. That secret is per-account
  // and the account is shared surface — the merchant portal's Check button signs
  // arbitrary transactions with it, and another project on the same profile
  // signs with it too — so a validly-signed `status=00` can name any amount at
  // all against one of our order ids. Without this, a RM0.01 claim settles a
  // RM1,200 charge in full. Fiuu's spec requires exactly this check: verify the
  // hash "AND compare the order id, currency, amount".
  //
  // ORDER IS LOAD-BEARING, in BOTH directions — this sits between the
  // already-decided short-circuits above and the revive/park block below.
  //
  // It must come AFTER 4a: otherwise every redelivery re-parks a dismissed row
  // and reverses a human's decision (see above).
  //
  // It must come BEFORE the revive: when it sat after, a swept row was revived
  // to `pending_approval` first, and the mismatch park that followed still
  // carried the PRE-revive status; its status-guarded write then matched zero
  // rows and returned before writing the notification or the audit. The result
  // was a signed unreconcilable claim that produced a console line and nothing
  // else — while leaving the row in exactly the state the requery sweep picks up
  // and settles in full.
  //
  // `undefined` means the channel does not report figures at all (the mock).
  // An EMPTY STRING means it reported nothing while claiming to — that is the
  // one-parameter bypass this guard exists to stop, so it must not be treated as
  // absent. Hence raw values here, with no collapsing anywhere upstream, and
  // comparison helpers that are strict about VALUE and tolerant about FORMAT.
  if (v.status === "success") {
    const amountDisagrees = v.amount !== undefined && !amountsAgree(v.amount, payment.amount);
    const currencyDisagrees = v.currency !== undefined && !currenciesAgree(v.currency, payment.currency);

    if (amountDisagrees || currencyDisagrees) {
      // Only reached once something ALREADY disagrees, so nothing that settles
      // today can arrive here. Before parking — which is itself the damage a
      // re-split body is after — check BOTH fields' shape, not just the one that
      // disagreed: the boundary can be moved so that the amount still parses
      // (`120` | `0.00MYR`) and only the currency gives it away.
      if (
        (v.amount !== undefined && !looksLikeAGatewayAmount(v.amount)) ||
        (v.currency !== undefined && !looksLikeACurrencyCode(v.currency))
      ) {
        return refuseMalleated(payment, v.amount, v.currency);
      }
      if (amountDisagrees) {
        return holdMismatch(payment, `amount mismatch: gateway said "${v.amount}", we recorded ${payment.amount}`);
      }
      return holdMismatch(payment, `currency mismatch: gateway said "${v.currency}", we recorded ${payment.currency}`);
    }
  }

  // 5) SUCCESS callback for a payment that is no longer pending.
  //
  //    A signed success is the gateway reporting that money MOVED. Local state
  //    cannot make that untrue, so this is never simply refused — doing so used
  //    to drop the money event entirely (Fiuu knocks 3 times over ~45 minutes
  //    and then stops forever, and nothing was persisted to find it by).
  //
  //    What we do depends on WHO ended the payment, because that is the only
  //    thing that distinguishes an accident from a decision:
  //
  //      • our own 30-minute sweep  → nobody judged this row, a timer did, and
  //        the timer was wrong (FPX has no published maximum pending duration).
  //        Revive it and settle: the tenant is credited, which is what the FPX
  //        merchant agreement requires us to do promptly.
  //
  //      • a human admin cancelled it, or the gateway itself said "failed"
  //        → a decision exists. Overriding it automatically would be worse than
  //        the delay, so the row is parked in `needs_reconciliation` with an
  //        audit row and a notification for someone to resolve.
  //
  //    Either way the caller ACKs the gateway, so its limited retries are never
  //    burned down against a refusal.
  if (payment.status !== "pending_approval") {
    // `needs_reconciliation` and `dismissed` are NOT re-checked here — they are
    // handled at 4a, above the amount comparison, and would be dead code at this
    // point. Keeping a second copy of a money guard is worse than none: the two
    // drift, and the reader cannot tell which one is load-bearing.
    const terminalActor = await resolveSystemActor(payment.organizationId);
    if (!terminalActor) {
      // Both branches below write an FK-constrained audit row, so neither is
      // available. Ack (the debit is real) and leave the row untouched for
      // manual reconciliation rather than half-applying anything.
      console.error("[fpx-callback] no admin actor for org — late success left unresolved", {
        paymentId: payment.id,
        status: payment.status,
      });
      return { ok: true, status: 200 };
    }

    const sweptByOurTimer = payment.status === "expired" && payment.gatewayStatus === "expired";

    if (!sweptByOurTimer) {
      await holdForReconciliationTx({
        paymentId: payment.id,
        organizationId: payment.organizationId,
        actorUserId: terminalActor.actorUserId,
        actorRole: terminalActor.actorRole,
        priorStatus: payment.status,
        priorGatewayStatus: payment.gatewayStatus,
      });
      return { ok: true, status: 200, applied: "parked" };
    }

    const revived = await reviveSweptFpxPaymentTx({
      paymentId: payment.id,
      organizationId: payment.organizationId,
      actorUserId: terminalActor.actorUserId,
      actorRole: terminalActor.actorRole,
    });
    if (!revived) {
      // Someone changed the row between our read and the revive. Whatever they
      // did, a concurrent actor is now handling it — ack rather than fight.
      console.error("[fpx-callback] swept payment changed under a late success — not revived", {
        paymentId: payment.id,
      });
      return { ok: true, status: 200 };
    }
    // Revived to `pending_approval`; fall through to the normal settle below.
  }

  // Resolve the system actor exactly as the auto-draft cron does.
  const actor = await resolveSystemActor(payment.organizationId);
  if (!actor) {
    // No admin to attribute the FK-constrained settle audit to. Ack the gateway
    // (the bank-side debit is done) but settle NOTHING and DON'T mark success —
    // the payment stays pending and is surfaced for manual reconciliation.
    console.error("[fpx-callback] no admin actor for org — cannot settle; payment left pending for reconciliation", {
      paymentId: payment.id,
      organizationId: payment.organizationId,
    });
    return { ok: true, status: 200 };
  }

  const systemSession = { orgId: payment.organizationId, userId: actor.actorUserId, role: actor.actorRole };
  const result = await postPaymentService(systemSession, { paymentId: payment.id });

  if (result.ok) {
    await setFpxGatewaySuccess(payment.id);
    return { ok: true, status: 200, applied: "settled" };
  }

  // Freeze the ok:false outcome's fields before any further narrowing.
  const settleStatus = result.status;
  const settleError = result.error;

  // A concurrent callback already posted it (race) → badStatus "(was posted)".
  // The settle happened exactly once; just reflect gatewayStatus and ack.
  if (settleStatus === 400 && /was posted/.test(settleError)) {
    await setFpxGatewaySuccess(payment.id);
    // `already_settled` — the OTHER caller applied the money, not us. Same
    // reasoning as the idempotency fast-path: the payer must see "received",
    // but the sweep must not count a rescue it did not perform.
    return { ok: true, status: 200, applied: "already_settled" };
  }

  // A TRUE concurrent double-callback: the OTHER callback won postPaymentTx's
  // updatedAt-in-WHERE transition, so THIS loser's postPaymentService returned a
  // 409 StaleError ("Changed since you loaded it") — NOT the "(was posted)" 400 the
  // fast-path above catches. Re-read before flagging: if a concurrent callback has
  // already settled the payment (now status "posted" or gatewayStatus "success"),
  // this is NOT a genuine failure — reflect success and ack, never write a spurious
  // `fpx_settle_failed` reconcile flag for a payment that actually settled fine.
  const recheck = await findPaymentByProviderTxnId(v.providerTxnId);
  if (recheck && (recheck.status === "posted" || recheck.gatewayStatus === "success")) {
    await setFpxGatewaySuccess(payment.id);
    return { ok: true, status: 200, applied: "already_settled" };
  }

  // Genuine settle failure (e.g. a charge's outstanding drifted → 409, or a
  // concurrent terminal transition). Do NOT claim success — leaving gatewayStatus
  // unset lets a later retry / manual post still apply a payment the bank debited.
  // Ack the gateway (200) so it stops retrying, and PARK it for a person.
  //
  // This used to write an AuditLog row and nothing else — no status change, no
  // notification. The row stayed `{pending_approval, pending}`, which meant:
  //   • `listPaymentsNeedingReconciliation` (status `needs_reconciliation`) never
  //     showed it, so the queue that exists for exactly this was blind to it;
  //   • the only admin action reachable on it was Cancel, i.e. writing off money
  //     the payer had already been debited for;
  //   • `findPendingFpxPaymentsForRequery` matched it forever, ordered `createdAt`
  //     asc — so it re-failed on every sweep and permanently held a slot of the
  //     50-row budget, in a channel whose own comments note Fiuu IP-bans for
  //     excessive querying.
  // Nobody had to attack anything for this: a credit note, an admin's manual
  // payment, or a second attempt on the same charge moves `outstandingAmount`
  // between initiate and callback, and `applyAllocationToChargeTx` then throws.
  //
  // So do what the figures-mismatch branch has always done — same helper, same
  // queue, same notification. gatewayStatus is still deliberately left alone, for
  // the same reason as before: stamping "success" would let the idempotency
  // fast-path skip a later retry or manual post of a payment the bank did pay.
  console.error("[fpx-callback] settle failed — needs reconciliation", {
    paymentId: payment.id,
    status: settleStatus,
    error: settleError,
  });
  // priorStatus comes from `recheck` — the row as it is NOW — not from `payment`,
  // which was read at step 2 and is stale by this point. `holdForReconciliationTx`
  // guards its write on `status: priorStatus`, so a stale value matches zero rows
  // and returns BEFORE the status change, the notification and the audit — while
  // this branch still reports `parked`. That is the F4 bug class the ordering
  // comment at 4b already documents in prose, and it bites here two ways:
  //   • deterministically after a revive, which flips the DB row to
  //     `pending_approval` while the local `payment` object still says `expired`;
  //   • on any concurrent status change during `postPaymentService`.
  // Either way the money is at the bank and the row silently stays in flight —
  // precisely the hole this whole branch was rewritten to close.
  const landed = await holdForReconciliationTx({
    paymentId: payment.id,
    organizationId: payment.organizationId,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    priorStatus: recheck?.status ?? payment.status,
    priorGatewayStatus: recheck?.gatewayStatus ?? payment.gatewayStatus,
    detail: `the bank confirmed this payment but it could not be applied (${settleError})`,
  });
  if (!landed) {
    // A concurrent actor moved the row between the re-read and the park. Say so
    // LOUDLY and do not claim `parked`: reporting a park that did not happen is
    // what made this invisible in the first place.
    console.error(
      "[fpx-callback] settle failed AND the park did not land — the row moved under us. " +
        "Money is at the bank and this payment may not be in the reconciliation queue: CHECK IT.",
      { paymentId: payment.id, triedPriorStatus: recheck?.status ?? payment.status },
    );
    return { ok: true, status: 200 };
  }
  // `parked`, not "nothing happened" — money the bank took that our books do not
  // yet show. Bucketing it with transport errors would hide a genuine settle
  // failure among "we could not reach the gateway".
  return { ok: true, status: 200, applied: "parked" };
}
