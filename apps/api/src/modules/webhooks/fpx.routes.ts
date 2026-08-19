import type { Hono } from "hono";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { getFpxGateway } from "../../lib/fpx";
import { handleFpxCallbackService } from "../payments/fpx-callback.service";

type Deps = { prisma: unknown };

/**
 * These routes are public, unauthenticated, and take a body we have to parse and
 * MD5 before we can know whether it is genuine — so the work is done for an
 * attacker as readily as for Fiuu. A real Fiuu notification is a form POST of a
 * few hundred bytes; 64 KB is two orders of magnitude of headroom and still
 * bounds what one request can make us buffer.
 *
 * NOT a rate limiter, deliberately. Fiuu sends only THREE retries at 15-minute
 * intervals and then stops forever, so a limiter that drops one is a lost money
 * event — the exact failure this whole module is built to avoid.
 */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

async function readCappedBody(c: { req: { text(): Promise<string>; header(n: string): string | undefined } }): Promise<string | null> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) return null;
  const body = await c.req.text();
  return body.length > MAX_WEBHOOK_BODY_BYTES ? null : body;
}

/**
 * Outbound IPN back-posts currently awaiting a response. Module-scoped, so it is
 * per-process — which is the right granularity: the thing being protected is
 * this host's IP reputation with Fiuu.
 */
let backPostsInFlight = 0;
const MAX_CONCURRENT_BACK_POSTS = 8;

/**
 * Public FPX webhooks. Mirrors mountWhatsAppWebhook: mounted in the "Public
 * webhooks — no auth middleware" section so they never touch the admin
 * authMiddleware. NO portalAuth — the callback's auth IS its HMAC signature,
 * verified inside handleFpxCallbackService. Both routes gate on ENABLE_PHASE2_FPX
 * (canonical 404 while dark).
 */
export function mountFpxWebhook(app: Hono, _deps: Deps): void {
  app.post("/webhooks/fpx/callback", async (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    // RAW body string — the HMAC must verify the EXACT bytes the gateway signed,
    // never a re-serialized JSON (c.req.json() would change key order / spacing).
    const rawBody = await readCappedBody(c);
    if (rawBody === null) return c.text("payload too large", 413);
    const signature = c.req.header("x-fpx-signature") ?? "";
    const r = await handleFpxCallbackService(rawBody, signature);
    return c.text(r.ok ? "ok" : "error", r.status as 200 | 400 | 404 | 409 | 500);
  });

  // MOCK-ONLY confirm. The mock FPX SPA page (Task 6) POSTs {providerTxnId,
  // outcome} here; the SERVER then signs the callback exactly as a real bank
  // would and runs the SAME settle path — so signing never leaves the server
  // (faithful to prod) and there is no client-forgeable signature. The mock-only
  // guard is structural: only the in-process mock exposes buildSignedCallback; a
  // real provider adapter omits it, so this route 404s on a prod deploy and can
  // never be used to forge a settle.
  app.post("/webhooks/fpx/mock-confirm", async (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    const gateway = getFpxGateway();
    if (typeof gateway.buildSignedCallback !== "function") return c.text("not found", 404);

    const body = (await c.req.json().catch(() => null)) as
      | { providerTxnId?: unknown; outcome?: unknown }
      | null;
    const providerTxnId = typeof body?.providerTxnId === "string" ? body.providerTxnId : "";
    const outcome = body?.outcome;
    if (!providerTxnId || (outcome !== "success" && outcome !== "failure")) {
      return c.text("bad request", 400);
    }

    const { rawBody, signature } = gateway.buildSignedCallback(
      providerTxnId,
      outcome === "failure" ? "failed" : "success",
    );
    const r = await handleFpxCallbackService(rawBody, signature);
    return c.text(r.ok ? "ok" : "error", r.status as 200 | 400 | 404 | 409 | 500);
  });

  // ── Fiuu (ex-MOLPay/Razer) real-provider endpoints ────────────────────────
  // Fiuu POSTs application/x-www-form-urlencoded with its signature (`skey`)
  // INSIDE the body; the molpay adapter verifies it, so these routes pass ""
  // as the signature header. Same settle core as the mock route — the service
  // is idempotent, so notify/callback/return all racing on one transaction
  // still settle exactly once.

  /**
   * Acknowledge a notification we HANDLED, in the form Fiuu expects for the
   * endpoint that actually fired.
   *
   * There is not one ack — there are two, and the body says which is wanted:
   *   nbcb = "1"  → Callback URL      → echo the literal CBTOKEN:MPSTATOK
   *   nbcb = "2"  → Notification URL  → post every received parameter back, plus
   *                                     `treq=1`, to Fiuu's chkstat endpoint
   *   nbcb absent → Return URL        → same back-post form
   *
   * Both portal fields point here, so both shapes arrive. Echoing the token
   * alone is correct while "Enable IPN" is UNTICKED on the Notification URL;
   * with it ticked, Fiuu never considers those acked and stops after 3 retries.
   * Doing both covers either setting, which is the point — the setting is not
   * visible from here.
   *
   * ⚠️ NEVER AWAIT THIS. It was originally awaited before the response, which
   * put an outbound HTTP call (up to 10s) in front of an ack Fiuu is waiting to
   * read — on a notification path that was ALREADY WORKING without it. If Fiuu's
   * read timeout is shorter than ours, the token never gets read and a retry is
   * spent, which is the precise failure this whole file exists to avoid. The
   * ack is cheap and certain; the back-post is speculative and slow, so it must
   * never gate the ack.
   *
   * Scoped to `nbcb === "2"` (the Notification URL). `nbcb` absent means the
   * browser Return URL, which is handled by its own route and never reaches
   * here, so there is nothing to back-post for.
   */
  function ackHandled(rawBody: string): void {
    const nbcb = new URLSearchParams(rawBody).get("nbcb") ?? "";
    if (nbcb !== "2") return;

    // Amplification cap. This route is public and a verified body is REPLAYABLE
    // (there is no nonce — the payer holds one for their own transaction), and
    // every handled `nbcb=2` fires an outbound POST at Fiuu. Without a cap, one
    // captured body replayed N times is N requests at pay.fiuu.com from our
    // production IP — and Fiuu blocks for excessive querying "without prior
    // notice", which takes the FPX rail offline for every tenant at once. That
    // is an unauthenticated remote kill-switch.
    //
    // Capped on the OUTBOUND side rather than the inbound one on purpose: Fiuu's
    // three retries must always be accepted, and skipping a back-post costs
    // nothing anyway — the CBTOKEN in the response body is what actually stops
    // Fiuu retrying. Genuine traffic never comes close to this ceiling.
    if (backPostsInFlight >= MAX_CONCURRENT_BACK_POSTS) {
      console.warn(
        "[fpx-molpay] IPN back-post skipped — too many already in flight. The ack token was still returned, " +
          "which is what stops Fiuu retrying; this only skips the belt-and-braces back-post.",
        { inFlight: backPostsInFlight },
      );
      return;
    }
    backPostsInFlight += 1;
    // try/finally around everything between the increment and the point the
    // decrement is attached. Nothing in here has a reachable throw today, but a
    // leak is permanent: eight of them disable back-posts for the life of the
    // process, and because this runs synchronously before the ack is returned, a
    // throw would cost the CBTOKEN too — burning one of Fiuu's three retries.
    // Cheap insurance against a counter that can only ever drift one way.
    try {
      const chkstat = process.env.MOLPAY_CHKSTAT_URL ?? "https://pay.fiuu.com/RMS/API/chkstat/returnipn.php";
      const echo = new URLSearchParams(rawBody);
      echo.set("treq", "1");
      void fetch(chkstat, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: echo.toString(),
        signal: AbortSignal.timeout(10_000),
      })
        .catch((err) =>
          console.warn("[fpx-molpay] IPN back-post failed; Fiuu may retry a payment we already applied", { err }),
        )
        .finally(() => {
          backPostsInFlight -= 1;
        });
    } catch (err) {
      backPostsInFlight -= 1;
      console.warn("[fpx-molpay] IPN back-post could not be started", { err });
    }
  }

  // Server-to-server Notification URL + deferred Callback URL (point BOTH Fiuu
  // portal fields here). Fiuu re-sends until it reads the literal ack token, so
  // any HANDLED event — settled, failed, pending no-op, or flagged for manual
  // reconciliation — echoes CBTOKEN:MPSTATOK; only an unverifiable/unknown body
  // stays an error (keep re-sending: it may be a mint we haven't committed yet).
  app.post("/webhooks/fpx/molpay/notify", async (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    const rawBody = await readCappedBody(c);
    if (rawBody === null) return c.text("payload too large", 413);
    const r = await handleFpxCallbackService(rawBody, "");
    if (!r.ok) {
      // A VERIFIED notification for an orderid we never minted: ack and ignore.
      // Our own flow can never race this — the Payment row commits BEFORE the
      // tenant is ever redirected to the gateway — so an unknown orderid is the
      // Fiuu portal's Check button (it signs a random transaction with the
      // account's real secret key) or another project's traffic on a shared
      // merchant account. Erroring would make Fiuu retry forever.
      if (r.status === 404) {
        console.warn("[fpx-molpay] verified notification for unknown orderid — acked and ignored");
        return c.text("CBTOKEN:MPSTATOK", 200);
      }
      // ONLY an unverifiable body stays an error. Fiuu retries just 3 times at
      // 15-minute intervals and then stops FOREVER, so every retry spent on a
      // response it cannot read is a retry that will not be there when we need
      // it. A body whose signature failed is worth re-sending (it may be a key
      // rotation, or a mint we have not committed yet); anything we actually
      // handled must ack, whatever we decided internally about the payment.
      //
      // The terminal-state 409 that used to land here is gone: the service now
      // revives or parks a late success instead of refusing it, so a real money
      // event can no longer burn down the retry budget and vanish.
      console.error("[fpx-molpay] unverifiable notification — not acked, Fiuu will retry", { status: r.status });
      return c.text("error", r.status as 400 | 500);
    }
    // Ack IMMEDIATELY; the back-post is fired without being waited on. Order
    // matters: the token is what stops Fiuu retrying, and nothing speculative
    // may delay it.
    ackHandled(rawBody);
    return c.text("CBTOKEN:MPSTATOK", 200);
  });

  // Probe responder. The Fiuu merchant portal's "Check" button (and uptime
  // monitors) probe with GET; real notifications are always form POSTs — a GET
  // carries no transaction data and can never settle anything.
  app.get("/webhooks/fpx/molpay/notify", (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    return c.text("OK", 200);
  });

  // Browser Return URL. Fiuu POSTs the payer's browser back here — the SPA on
  // S3/CloudFront cannot receive a POST, so the API takes it, settles-if-first
  // (belt and braces vs a lost notify; idempotent either way), and bounces the
  // payer to the portal payments page, which reads real state from the API.
  // ALWAYS redirect — a tenant's browser must never dead-end on a webhook error.
  app.post("/webhooks/fpx/molpay/return", async (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    // Over-cap still REDIRECTS: a tenant's browser must never dead-end on a
    // webhook error, and the portal page it lands on reads real state anyway.
    const rawBody = await readCappedBody(c);
    if (rawBody === null) return c.redirect(`${process.env.APP_WEB_ORIGIN ?? ""}/portal/payments`, 302);
    const applied = await handleFpxCallbackService(rawBody, "");

    // Tell the payer what ACTUALLY happened. The SPA's outcome banner reads
    // `?fpx=`, and until recently ONLY the mock page ever set it — so a real
    // payer completed a bank transfer and landed on a bare list with no
    // confirmation at all, which is the moment they are most likely to pay twice.
    //
    // Derived from what the handler DID, not from the raw gateway status. Those
    // differ: a signed success whose figures do not match ours is parked for a
    // human, and telling that payer "Your payment was received" is a promise we
    // have not kept — their charge is still open and nobody has applied anything.
    //
    // The signature is re-checked separately (verifyCallback is a pure MD5 check
    // with no side effects) so an UNSIGNED body can never choose the message.
    let outcome = "";
    const v = getFpxGateway().verifyCallback(rawBody, "");
    if (v.valid) {
      // `parked` is shown as pending, not success: the money is real but nothing
      // has been applied yet, which is exactly what the pending copy describes.
      //
      // `already_settled` counts as received — the money IS applied, just by an
      // earlier delivery. Fiuu's server-to-server notify usually beats the
      // payer's browser back, so that is the NORMAL path for a successful
      // payment; reading only `settled` here told almost every successful payer
      // their payment was still pending.
      const isApplied = applied.applied === "settled" || applied.applied === "already_settled";
      const shown = v.status === "success" && !isApplied ? "pending" : v.status;
      outcome = `?fpx=${shown}`;
    }

    return c.redirect(`${process.env.APP_WEB_ORIGIN ?? ""}/portal/payments${outcome}`, 302);
  });

  // A payer refreshing / revisiting the return URL arrives as GET — same bounce.
  app.get("/webhooks/fpx/molpay/return", (c) => {
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_FPX")) return c.text("not found", 404);
    return c.redirect(`${process.env.APP_WEB_ORIGIN ?? ""}/portal/payments`, 302);
  });
}
