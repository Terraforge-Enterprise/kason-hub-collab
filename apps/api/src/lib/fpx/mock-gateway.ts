import crypto from "node:crypto";
import type {
  FpxCallbackResult,
  FpxGateway,
  FpxInitiateRequest,
  FpxInitiateResult,
  FpxStatusQueryResult,
} from "./gateway";

/**
 * Well-known dev/CI secret. A real deployment overrides it via FPX_MOCK_SECRET;
 * the constant only exists so local dev and unit tests sign/verify consistently
 * without any env setup. It is NOT a credential to a real bank — the mock never
 * moves money.
 */
const DEV_DEFAULT_SECRET = "fpx-mock-dev-secret";

/**
 * Production-grade in-process FPX mock. It does everything the real gateway
 * boundary requires — HMAC-SHA256-signs its callbacks and verifies them with a
 * constant-time compare — so the entire payment flow (initiate → redirect →
 * signed callback → verify) is exercised end-to-end without a real bank.
 * `buildSignedCallback` is the seam the mock FPX SPA page / dev tooling uses to
 * produce a callback the API will accept; the real adapter omits it.
 */
export class MockFpxGateway implements FpxGateway {
  readonly provider = "fpx-mock" as const;

  /**
   * Shared HMAC secret, read lazily per call. Reading at call time (rather than
   * capturing in a constructor) means a secret injected after this — memoized —
   * instance is built is still honoured, and sign + verify always agree on the
   * current value. Falls back to the dev default when unset.
   */
  private secret(): string {
    return process.env.FPX_MOCK_SECRET ?? DEV_DEFAULT_SECRET;
  }

  private sign(rawBody: string): string {
    return crypto.createHmac("sha256", this.secret()).update(rawBody).digest("hex");
  }

  async initiate(req: FpxInitiateRequest): Promise<FpxInitiateResult> {
    // Relative when APP_WEB_ORIGIN is unset — fine for the SPA, which resolves
    // it against its own origin. The mock FPX page reads txn + amount to render
    // a "pay / fail" choice and POST back a signed callback.
    const origin = process.env.APP_WEB_ORIGIN ?? "";
    const redirectUrl = `${origin}/portal/fpx/mock?txn=${req.providerTxnId}&amount=${req.amount}`;
    return { redirectUrl };
  }

  verifyCallback(rawBody: string, signature: string): FpxCallbackResult {
    const expected = this.sign(rawBody);
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(signature, "utf8");
    // timingSafeEqual throws on a length mismatch, so gate on length first — a
    // wrong-length (or non-hex / empty) signature is a clean "invalid", never a
    // thrown error escaping the verifier.
    const matches =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);
    if (!matches) {
      // Signature failed: do not echo back anything from the (possibly tampered) body.
      return { valid: false, providerTxnId: "", status: "failed" };
    }
    try {
      const parsed = JSON.parse(rawBody) as { providerTxnId?: unknown; status?: unknown };
      const providerTxnId = typeof parsed.providerTxnId === "string" ? parsed.providerTxnId : "";
      const status = parsed.status === "success" ? "success" : "failed";
      return { valid: true, providerTxnId, status };
    } catch {
      // Verified signature over a non-JSON body should never happen via this
      // mock, but never let a parse error escape verification.
      return { valid: false, providerTxnId: "", status: "failed" };
    }
  }

  /**
   * There is no bank behind the mock to ask, so it declines to answer rather
   * than inventing one. `unsupported` is a first-class outcome the sweeper
   * already handles by leaving the payment untouched — which is exactly right
   * here: a fabricated "failed" would let dev tooling terminate payments on the
   * strength of nothing at all.
   *
   * Drive mock outcomes through /webhooks/fpx/mock-confirm instead, which runs
   * the same signed-callback path a real gateway would.
   */
  async queryStatus(): Promise<FpxStatusQueryResult> {
    return { ok: false, reason: "unsupported" };
  }

  buildSignedCallback(
    providerTxnId: string,
    outcome: "success" | "failed",
  ): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify({ providerTxnId, status: outcome });
    return { rawBody, signature: this.sign(rawBody) };
  }
}
