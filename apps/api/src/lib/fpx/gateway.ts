import type { FpxProviderId } from "./providers";

/**
 * FPX payment-gateway adapter boundary.
 *
 * KAEN tenants pay rent + utilities through the portal via Malaysian FPX
 * (online banking). Two adapters implement this interface: the production-grade
 * MOCK (`mock-gateway.ts` — dev/CI default) and the real Fiuu (ex-MOLPay /
 * Razer Merchant Services) hosted-page adapter (`molpay-gateway.ts`). The env
 * selector in `index.ts` picks one — no payment-flow code knows which. Mirrors
 * the WhatsApp sender adapter in `lib/whatsapp/`.
 */

/** Billing display fields for the gateway's hosted payment page. */
export interface FpxPayerInfo {
  name?: string;
  email?: string;
  mobile?: string;
}

export interface FpxInitiateRequest {
  /**
   * Our transaction id; round-trips through the gateway back to the callback.
   * Fiuu's `orderid` field is string(32) — mint hyphen-less UUIDs (exactly 32
   * chars), never anything longer.
   */
  providerTxnId: string;
  /** Decimal string in MYR, e.g. "1250.00". String to avoid float drift. */
  amount: string;
  description: string;
  /** Where the SPA returns the payer after the bank flow completes. */
  returnUrl: string;
  /** Optional tenant billing details shown on the hosted payment page. */
  payer?: FpxPayerInfo;
}

export interface FpxInitiateResult {
  /** URL to redirect the payer to (the bank-selection / mock page). */
  redirectUrl: string;
}

export interface FpxCallbackResult {
  /** True only when the signature verified — never trust the body otherwise. */
  valid: boolean;
  providerTxnId: string;
  /**
   * The GATEWAY's own transaction id (Fiuu's `tranID`), as distinct from
   * `providerTxnId`, which is OUR order id. Optional: the mock does not mint one.
   *
   * Worth persisting the first time it is seen. Fiuu's status-requery APIs are
   * retention-limited per lookup key — by order id the history is 7 days, by
   * their transaction id it is 180. The FPX Merchant Services Agreement gives a
   * payer 60 days to demand funds back, so the order-id path cannot cover our
   * own dispute window and the transaction-id path comfortably can.
   */
  providerTranId?: string;
  /**
   * The amount and currency the GATEWAY says were paid, surfaced ONLY on a
   * verified body.
   *
   * The signature proves "the gateway signed this with our account's secret" —
   * NOT "this is the payment we asked for". That secret is per-ACCOUNT, and the
   * account is shared surface: the merchant portal's own Check button signs
   * arbitrary transactions with it, and any other project on the same merchant
   * profile signs with it too. So a validly-signed `status=00` can carry any
   * amount at all against one of our order ids.
   *
   * Fiuu's spec is explicit that the checksum alone is not the check — merchants
   * "MUST verify this hash string properly AND compare the order id, currency,
   * amount, and also the payment date/time". These fields exist so the caller
   * can do that before settling anything.
   */
  amount?: string;
  currency?: string;
  /**
   * "pending" (Fiuu status 22) = the bank flow is still in motion: acknowledge
   * and change NOTHING — a terminal success/failed notification arrives later.
   * Mapping pending to "failed" would mark the payment failed and strand the
   * later real success at the callback service's resurrect guard (409) after
   * the bank already debited the tenant.
   */
  status: "success" | "failed" | "pending";
}

/**
 * What the gateway says when we ASK about a transaction, rather than waiting to
 * be told.
 *
 * The `ok: false` half is the whole safety property of this type, and it is why
 * this is not simply `FpxCallbackResult`. "The gateway says this payment failed"
 * and "we could not find out" must never collapse into the same value: the first
 * may terminate a payment, the second must leave it exactly as it was. A
 * transport error, an unverifiable response, or a response we cannot confidently
 * parse are ALL `ok: false` — because acting on a misread reply is precisely how
 * a live payment gets killed while the payer's money is in flight.
 */
export type FpxStatusQueryResult =
  | {
      ok: true;
      /** Same vocabulary as a callback: "pending" is NOT a failure. */
      status: "success" | "failed" | "pending";
      /** The gateway's own transaction id, when the reply carries one. */
      providerTranId?: string;
      /**
       * What the gateway says was paid — the SAME comparison material a callback
       * carries, and for the same reason.
       *
       * A poll and a push must settle identically. When only the callback path
       * compared amounts, a payment settled differently depending on which
       * channel happened to reach us first: a reply naming RM1.00 against a
       * RM150 charge sailed through the poll while the identical callback was
       * parked. An adapter that can supply these MUST, so the caller can check.
       */
      amount?: string;
      currency?: string;
    }
  | {
      ok: false;
      /**
       * `not_found` — the gateway has no record. NOT proof of failure: every
       *   requery API has a retention horizon (7 days by order id), past which a
       *   perfectly real settled payment also returns nothing.
       * `unverified` — reply arrived but its checksum did not match, or it could
       *   not be parsed into a status we recognise.
       * `transport` — never reached the gateway (network, timeout, 5xx).
       * `unsupported` — this adapter cannot query (e.g. the mock).
       */
      reason: "not_found" | "unverified" | "transport" | "unsupported";
      detail?: string;
    };

export interface FpxGateway {
  /**
   * Stamped on `Payment.provider` at initiate. Lookups deliberately match ALL
   * ids in `providers.ts` (not just the active one) so a provider swap never
   * orphans in-flight rows.
   */
  readonly provider: FpxProviderId;
  initiate(req: FpxInitiateRequest): Promise<FpxInitiateResult>;
  /**
   * Ask the gateway what happened to a transaction — the ACTIVE counterpart to
   * `verifyCallback`'s passive wait.
   *
   * Needed because the notification channel is not reliable enough to be the only
   * one: Fiuu retries a callback 3 times at 15-minute intervals and then stops
   * permanently, so a webhook lost to a deploy or an outage is lost for good. Its
   * own documentation tells merchants to poll pending transactions every half
   * hour rather than time them out locally.
   *
   * Prefer `providerTranId` (the gateway's id) over `providerTxnId` (ours) where
   * the adapter supports both: retention is 180 days by their id versus 7 by
   * ours, against a 60-day window in which a payer can still dispute.
   */
  queryStatus(req: {
    /** OUR order id — always present. */
    providerTxnId: string;
    /** The GATEWAY's id, when we have captured it. Preferred lookup key. */
    providerTranId?: string;
    /** Exact 2dp amount string, required by the checksum on some adapters. */
    amount: string;
  }): Promise<FpxStatusQueryResult>;
  /**
   * rawBody = the exact byte-for-byte body the gateway POSTed (JSON for the
   * mock, x-www-form-urlencoded for Fiuu). signature = the x-fpx-signature
   * header — mock only; Fiuu carries its `skey` hash inside the body and the
   * molpay routes pass "" here.
   */
  verifyCallback(rawBody: string, signature: string): FpxCallbackResult;
  /** MOCK ONLY: produce the {rawBody, signature} a real gateway would POST. undefined on the real adapter. */
  buildSignedCallback?(
    providerTxnId: string,
    outcome: "success" | "failed",
  ): { rawBody: string; signature: string };
}
