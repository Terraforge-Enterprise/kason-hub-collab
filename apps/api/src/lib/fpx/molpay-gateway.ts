import crypto from "node:crypto";
import type {
  FpxCallbackResult,
  FpxGateway,
  FpxInitiateRequest,
  FpxInitiateResult,
  FpxStatusQueryResult,
} from "./gateway";

/**
 * Fiuu (ex-MOLPay / Razer Merchant Services) hosted-payment-page adapter.
 *
 * Initiate is a pure URL build — the payer's browser is redirected to Fiuu's
 * hosted page with MD5-signed parameters (`vcode`); no server-to-server call.
 * Fiuu then POSTs `application/x-www-form-urlencoded` results to our public
 * return/notify routes with its own MD5 chain (`skey`) INSIDE the body — the
 * `signature` argument of `verifyCallback` is unused here (routes pass "").
 *
 * Env (see `cfg()`): MOLPAY_MERCHANT_ID, MOLPAY_VERIFY_KEY (signs outgoing
 * requests), MOLPAY_SECRET_KEY (verifies incoming results), optional
 * MOLPAY_BASE_URL (defaults to Fiuu's production domain — dev `_Dev` merchant
 * accounts run there in test mode) and MOLPAY_RETURN_URL (per-request
 * returnurl override; when unset the Return URL configured in the Fiuu
 * merchant portal applies).
 */

/**
 * Pay-URL prefix — everything before "/pay/{merchantID}/". Legacy MOLPay
 * domain by default (where `_Dev` accounts live — the merchant portal's own
 * generated snippets reference it); Fiuu's current docs host the same API at
 * "https://pay.fiuu.com/RMS", so a domain migration is ONLY the
 * MOLPAY_BASE_URL env var, never a code change.
 */
// ⚠️ DO NOT "modernise" this default without a live test first.
//
// Fiuu's current spec, its PHP SDK and its WooCommerce plugin all use
// pay.fiuu.com — the v13.25 changelog (2021-08-24) records "Changing all
// www.onlinepayment.com.my to pay.fiuu.com" — so on documentation alone this
// host looks retired. It was changed to pay.fiuu.com on that reasoning, and that
// was a mistake: `MOLPAY_BASE_URL` is NOT set in any deploy, so the default IS
// the live payment URL, and the `caroonsoft_Dev` account had already been tested
// end-to-end against THIS host. Flipping it silently re-pointed a proven-working
// checkout at an untested one, and changed the path with it
// (`/MOLPay/pay/{mid}/` → `/RMS/pay/{mid}/`).
//
// Documentation says the new host is right; a passing live transaction says this
// one is. The live transaction wins until a new one replaces it. Migrating is a
// deliberate change: set MOLPAY_BASE_URL="https://pay.fiuu.com/RMS" on one
// environment, put a real payment through, then move the default.
// Sandbox is https://sandbox-payment.fiuu.com/RMS, likewise env-only.
const DEFAULT_BASE_URL = "https://www.onlinepayment.com.my/MOLPay";

/**
 * Status-requery host. NOT the same as the pay host: the legacy
 * `onlinepayment.com.my` domain that still serves hosted payment pages was shut
 * down for APIs on 1 Nov 2017, and the query endpoints live on `api.fiuu.com`.
 * Overridable so the sandbox (`sandbox-payment.fiuu.com`) is an env change.
 */
const DEFAULT_API_URL = "https://api.fiuu.com";

/** Requery reply `StatCode` → adapter status. Deliberately NOT defaulted. */
const QUERY_STATUS_MAP: Record<string, "success" | "failed" | "pending"> = {
  "00": "success",
  "11": "failed",
  "22": "pending",
};

/**
 * Pull a field out of a requery reply without betting on its exact casing.
 * Fiuu's documented response field list (`StatCode`, `TranID`, `VrfKey`, …) is
 * not consistently cased across its own documents and SDK samples.
 */
function pick(fields: Map<string, string>, ...names: string[]): string {
  for (const n of names) {
    const v = fields.get(n.toLowerCase());
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/**
 * Parse a requery reply into a flat field map, handling the shapes Fiuu actually
 * returns: a JSON object (`type=2`) or newline/colon text (`type=0`, the
 * default). Returns an EMPTY map when
 * nothing recognisable can be extracted — the caller then reports `unverified`
 * rather than guessing, because a misread reply is how a live payment gets
 * killed while the payer's money is still in flight.
 */
function parseQueryReply(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const trimmed = body.trim();
  if (!trimmed) return out;

  // `type=2` — JSON object.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v != null && typeof v !== "object") out.set(k.toLowerCase(), String(v));
      }
      return out;
    } catch {
      return out;
    }
  }

  // DEFAULT (`type=0`) — newline-separated `Key: Value`, e.g.
  //     StatCode: 00
  //     StatName: captured
  //     TranID: 10645406
  //
  // This is what Fiuu actually sends and it was the shape this parser could not
  // read: it matched neither the JSON branch nor the `key=value` branch, so the
  // map came back empty, StatCode was blank, and EVERY requery reported
  // "unverified" — leaving the active half of settlement silently inert.
  //
  // Split on the FIRST colon only. Fiuu's own WooCommerce plugin uses an
  // unbounded `explode(':', $line)` and is wrong here: BillingDate is
  // `YYYY-MM-DD HH:mm:ss` and carries two more colons, so their parser truncates
  // it. Do not copy that.
  // Colon form, decided PER LINE — never over the whole body. Testing
  // `!body.includes("=")` meant a single `=` anywhere (inside a URL, a reference
  // field, a padded token) threw the entire reply into a query-string branch,
  // producing garbage keys from a reply that plainly said `StatCode: 00` — and
  // the non-empty garbage was then reported as "not_found", i.e. "the gateway
  // has no record", for a transaction it had just described.
  //
  // There is deliberately NO `key=value` fallback. The spec defines exactly three
  // response shapes — `type=0` plain text (this one, the default), `type=1`
  // POSTed to a `url` parameter the adapter never sends, and `type=2` JSON
  // (handled above). A query-string BODY is not among them, so a fallback for it
  // parsed a shape these endpoints never return — while being subtly wrong about
  // a shape they do: a `&`-joined line carrying a timestamp got captured by the
  // colon branch and mis-split. Unreachable and incorrect is strictly worse than
  // absent.
  for (const line of trimmed.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    // Field names are bracketed in some samples ("[StatCode]") — strip them.
    const key = line.slice(0, colon).trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (key) out.set(key, line.slice(colon + 1).trim());
  }
  return out;
}

/** Fiuu payment-status codes → adapter statuses. Anything unknown = failed. */
const STATUS_MAP: Record<string, FpxCallbackResult["status"]> = {
  "00": "success",
  "11": "failed",
  "22": "pending",
};

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

export class MolpayFpxGateway implements FpxGateway {
  readonly provider = "molpay" as const;

  constructor() {
    // Fail fast on missing credentials — at gateway SELECTION, before any
    // Payment row exists — instead of stranding a fresh pending row behind a
    // mid-initiate throw. Values are still read per call in cfg() so tests
    // (and a rotated secret) are honoured without rebuilding the memoized
    // instance.
    this.cfg();
  }

  private cfg() {
    const merchantId = process.env.MOLPAY_MERCHANT_ID;
    const verifyKey = process.env.MOLPAY_VERIFY_KEY;
    const secretKey = process.env.MOLPAY_SECRET_KEY;
    const missing = [
      !merchantId && "MOLPAY_MERCHANT_ID",
      !verifyKey && "MOLPAY_VERIFY_KEY",
      !secretKey && "MOLPAY_SECRET_KEY",
    ].filter((v): v is string => typeof v === "string");
    if (missing.length) {
      throw new Error(`FPX_PROVIDER=molpay requires env: ${missing.join(", ")}`);
    }
    return {
      merchantId: merchantId as string,
      verifyKey: verifyKey as string,
      secretKey: secretKey as string,
      baseUrl: process.env.MOLPAY_BASE_URL ?? DEFAULT_BASE_URL,
      apiUrl: process.env.MOLPAY_API_URL ?? DEFAULT_API_URL,
      returnUrl: process.env.MOLPAY_RETURN_URL,
    };
  }

  /**
   * Ask Fiuu what happened to a transaction.
   *
   * Keyed on the gateway's own `tranID` when we have it and our `orderid`
   * otherwise — retention is 180 days by theirs versus 7 by ours, and a payer has
   * 60 days to dispute, so the order-id path alone cannot cover our own liability
   * window.
   *
   * EVERY uncertain outcome returns `ok:false`. Fiuu's reply is plain text whose
   * exact field casing varies across its own documents, so the parse is tolerant
   * on the way in and strict on the way out: no recognised `StatCode`, or a
   * checksum that does not verify, is reported as `unverified` and NEVER as a
   * failure. The worst case is therefore that the sweeper does nothing, which is
   * the correct way for this to break.
   *
   * ⚠️ The response contract has not been exercised against a live Fiuu sandbox
   * yet. Request signing follows the published spec; the reply parse is a
   * best-effort read of a format the spec does not pin down. Confirm against a
   * real sandbox transaction before relying on it to terminate payments.
   */
  async queryStatus(req: {
    providerTxnId: string;
    providerTranId?: string;
    amount: string;
  }): Promise<FpxStatusQueryResult> {
    const c = this.cfg();
    const useTranId = Boolean(req.providerTranId);
    const key = useTranId ? (req.providerTranId as string) : req.providerTxnId;
    const endpoint = useTranId
      // NOTE the asymmetry — it is in the spec, not a typo. q_by_tid sits at
      // /RMS/, q_by_oid at /RMS/query/. Giving tid the /query/ segment 404s it,
      // and tid is the path most rows take (it is preferred whenever we have the
      // gateway's own id), so the error was hitting the common case.
      ? `${c.apiUrl}/RMS/q_by_tid.php`
      : `${c.apiUrl}/RMS/query/q_by_oid.php`;

    // Documented as md5(<lookup key> + merchantID + verify_key + amount) for both
    // the order-id and transaction-id variants.
    const skey = md5(`${key}${c.merchantId}${c.verifyKey}${req.amount}`);
    const body = new URLSearchParams({
      amount: req.amount,
      domain: c.merchantId,
      skey,
      // NOT requesting JSON (`type=2`), deliberately — though NOT for the reason
      // originally written here. The spec's own JSON sample quotes the amount
      // (`"Amount": "3899.00"`), so the decimal survives and the checksum
      // verifies fine; that rationale was wrong.
      //
      // The real reasons: `type=0` is the documented DEFAULT, and the spec marks
      // `type` "obsoleted in new API sets" for q_by_tid — the endpoint we prefer.
      // Asking for a format that may be ignored, when the default is the one the
      // parser is written and tested against, buys nothing and risks a silent
      // shape change.
      ...(useTranId ? { txID: key } : { oID: key }),
    });

    let text: string;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        // Fiuu IP-bans for excessive querying, so a hung request must not become
        // a retry storm from the sweeper — fail fast and leave the row alone.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return { ok: false, reason: "transport", detail: `HTTP ${res.status}` };
      }
      text = await res.text();
    } catch (err) {
      return { ok: false, reason: "transport", detail: err instanceof Error ? err.message : "fetch failed" };
    }

    const fields = parseQueryReply(text);
    const statCode = pick(fields, "StatCode", "stat_code", "status");
    if (!statCode) {
      // Includes Fiuu's "no record" replies. Explicitly NOT a failure: every
      // requery API has a retention horizon past which a genuinely settled
      // payment also returns nothing.
      return { ok: false, reason: fields.size === 0 ? "unverified" : "not_found", detail: text.slice(0, 200) };
    }

    const mapped = QUERY_STATUS_MAP[statCode];
    if (!mapped) {
      return { ok: false, reason: "unverified", detail: `unrecognised StatCode ${statCode}` };
    }

    // Verify the reply's own checksum when it carries one. An unsigned or
    // mis-signed reply may not terminate a payment.
    const vrfKey = pick(fields, "VrfKey", "vrf_key");
    // The REPLY's own amount, kept separate from the fallback used for the
    // checksum. Falling back to `req.amount` for the returned value would mean
    // the gateway never had to agree with us — the caller would then "compare"
    // our own figure against itself and always pass.
    const replyAmount = pick(fields, "Amount");
    const amountForChecksum = replyAmount || req.amount;
    const tranId = pick(fields, "TranID", "tran_id");
    const orderId = pick(fields, "OrderID", "order_id") || req.providerTxnId;
    const subject = useTranId ? tranId || key : orderId;

    // The checksum subject comes out of the REPLY, so on its own it proves only
    // "this is a correctly-signed answer about SOME transaction" — the reply gets
    // to choose which one. It must also be an answer about the transaction we
    // ASKED about, or a reply naming a different transaction verifies fine and
    // its outcome is then applied to our payment by `applyVerifiedFpxOutcome`
    // (which is passed OUR providerTxnId regardless of what came back). On the
    // q_by_oid path the reply's TranID is additionally persisted write-once as
    // this payment's only 180-day requery key, so a wrong one mis-keys it forever.
    //
    // Tolerant on format, strict on identity: trimmed, case-insensitive. A reply
    // that omits the field is unchanged — `subject` already falls back to the key
    // we queried in that case, so this can only reject a reply that named a
    // DIFFERENT transaction. Failure mode is "do nothing", the direction this
    // whole adapter is written to fail in.
    if (subject.trim().toLowerCase() !== key.trim().toLowerCase()) {
      return {
        ok: false,
        reason: "unverified",
        detail: `reply is about a different transaction (asked ${key}, got ${subject})`,
      };
    }

    const expected = md5(`${amountForChecksum}${c.secretKey}${c.merchantId}${subject}${statCode}`);
    if (!vrfKey || vrfKey.toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, reason: "unverified", detail: "VrfKey mismatch" };
    }

    return {
      ok: true,
      status: mapped,
      providerTranId: tranId || undefined,
      // Raw, uncollapsed — same discipline as verifyCallback. The caller must be
      // able to tell "the gateway said nothing about the amount" apart from "the
      // gateway agreed", because only one of those is safe to settle on.
      amount: replyAmount,
      currency: pick(fields, "Currency", "currency"),
    };
  }

  async initiate(req: FpxInitiateRequest): Promise<FpxInitiateResult> {
    const c = this.cfg();
    // vcode = md5(amount + merchantID + orderid + verify key): Fiuu recomputes
    // it ("Enable Verify Payment") and rejects any request whose amount was
    // tampered with in transit. amount MUST be the exact 2-dp string sent.
    const vcode = md5(`${req.amount}${c.merchantId}${req.providerTxnId}${c.verifyKey}`);
    const params = new URLSearchParams({
      amount: req.amount,
      orderid: req.providerTxnId,
      bill_name: req.payer?.name ?? "KAEN Tenant",
      bill_email: req.payer?.email ?? "",
      bill_mobile: req.payer?.mobile ?? "",
      bill_desc: req.description,
      country: "MY",
      currency: "MYR",
      vcode,
    });
    // Per-request returnurl overrides the portal-configured Return URL — this
    // must be an API route (the SPA sits on S3/CloudFront, which cannot accept
    // Fiuu's browser POST), never the SPA's own returnUrl from req.
    if (c.returnUrl) params.set("returnurl", c.returnUrl);
    const redirectUrl = `${c.baseUrl}/pay/${encodeURIComponent(c.merchantId)}/?${params.toString()}`;
    return { redirectUrl };
  }

  verifyCallback(rawBody: string, _signature: string): FpxCallbackResult {
    // Signature failed ⇒ echo NOTHING from the (possibly forged) body.
    const invalid: FpxCallbackResult = { valid: false, providerTxnId: "", status: "failed" };
    const c = this.cfg();
    const fields = new URLSearchParams(rawBody);
    const tranID = fields.get("tranID") ?? "";
    const orderid = fields.get("orderid") ?? "";
    const status = fields.get("status") ?? "";
    const domain = fields.get("domain") ?? "";
    const amount = fields.get("amount") ?? "";
    const currency = fields.get("currency") ?? "";
    const appcode = fields.get("appcode") ?? "";
    const paydate = fields.get("paydate") ?? "";
    const skey = fields.get("skey") ?? "";
    if (!skey || !orderid) return invalid;

    // Fiuu's documented two-step chain; the secret key never leaves the server,
    // so a forged body cannot produce a matching skey.
    const key0 = md5(`${tranID}${orderid}${status}${domain}${amount}${currency}`);
    const expected = md5(`${paydate}${domain}${key0}${appcode}${c.secretKey}`);
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(skey, "utf8");
    // timingSafeEqual throws on a length mismatch — gate on length first so a
    // wrong-length skey is a clean "invalid", never a thrown error.
    const matches =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);
    if (!matches) return invalid;

    // The body is signed with OUR ACCOUNT's secret — but so is every other
    // transaction on that account, including the portal's Check button and any
    // other project sharing the merchant profile. A body naming a different
    // merchant is not ours to act on, whatever it is signed with. The spec's own
    // sample makes the same point: "by right both values should be identical".
    // Trimmed + case-insensitive, deliberately. This check is NEW on a path that
    // was already working end-to-end, and an exact string compare would turn any
    // incidental difference — stray whitespace, a differently-cased env var —
    // into a rejected callback: 400, no ack, one of Fiuu's three retries burned,
    // and eventually a debited payer with nothing recorded. The check exists to
    // stop a body naming a DIFFERENT merchant, and case carries no signal there,
    // exactly as with the currency comparison.
    if (domain.trim().toLowerCase() !== c.merchantId.trim().toLowerCase()) {
      // LOUD, and deliberately distinct from every other invalid-body log.
      //
      // This gate sits in front of every payment and was added to a path that
      // already worked. The skey chain hashes `domain` FROM THE BODY, so a
      // correct signature is produced whatever it contains — meaning the passing
      // live transaction proves the signature works but proves nothing about
      // whether Fiuu populates `domain` with the merchant id. The spec's own
      // sample reads `$merchant = $_POST['domain']` and notes "by right both
      // values should be identical", which is why the gate is here at all.
      //
      // If that assumption is ever wrong, the symptom is the whole FPX rail
      // going silent: no ack, three retries burned, payers debited with nothing
      // recorded. This line is what makes that diagnosable in one log search
      // instead of one angry tenant. Do not downgrade it to a generic invalid.
      console.error(
        "[fpx-molpay] callback REJECTED on merchant mismatch — no ack will be sent. " +
          "If this fires for a genuine payment, the domain assumption is wrong and the rail is down.",
        { bodyDomain: domain, expectedMerchantId: c.merchantId },
      );
      return invalid;
    }

    // `tranID` is surfaced (not just consumed by the skey chain above) so the
    // callback path can persist it — it is the only key with a 180-day requery
    // window, and it is knowable ONLY from a message Fiuu sends us. `amount` and
    // `currency` are surfaced so the caller can perform the comparison the spec
    // requires; both come from the body ONLY on this verified branch.
    return {
      valid: true,
      providerTxnId: orderid,
      providerTranId: tranID || undefined,
      // Surfaced RAW — an empty string stays an empty string and is NOT collapsed
      // to `undefined`. The caller's guard skips when these are absent, so
      // collapsing handed the exact actor the guard targets a one-parameter
      // bypass: send `amount=` and the comparison disappears. The skey chain
      // hashes whatever is present, so an empty amount signs perfectly well.
      amount,
      currency,
      status: STATUS_MAP[status] ?? "failed",
    };
  }
}
