import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MolpayFpxGateway } from "../molpay-gateway";
import { MockFpxGateway } from "../mock-gateway";
import { getFpxGateway, resetFpxGateway } from "../index";

const MID = "test_Dev";
const VKEY = "vk-0123-verify";
const SKEY = "sk-4567-secret";

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

/** Build the x-www-form-urlencoded body Fiuu would POST, with a VALID skey. */
function signedBody(overrides: Partial<Record<string, string>> = {}, secret = SKEY): string {
  const f = {
    tranID: "998877",
    orderid: "a".repeat(32),
    status: "00",
    domain: MID,
    amount: "1250.00",
    currency: "MYR",
    appcode: "APP123",
    paydate: "2026-08-06 10:00:00",
    ...overrides,
  };
  const key0 = md5(`${f.tranID}${f.orderid}${f.status}${f.domain}${f.amount}${f.currency}`);
  const skey = md5(`${f.paydate}${f.domain}${key0}${f.appcode}${secret}`);
  return new URLSearchParams({ ...f, skey }).toString();
}

const ENV_KEYS = [
  "MOLPAY_MERCHANT_ID",
  "MOLPAY_VERIFY_KEY",
  "MOLPAY_SECRET_KEY",
  "MOLPAY_BASE_URL",
  "MOLPAY_RETURN_URL",
  "MOLPAY_API_URL",
  "FPX_PROVIDER",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MOLPAY_MERCHANT_ID = MID;
  process.env.MOLPAY_VERIFY_KEY = VKEY;
  process.env.MOLPAY_SECRET_KEY = SKEY;
  delete process.env.MOLPAY_BASE_URL;
  delete process.env.MOLPAY_RETURN_URL;
  resetFpxGateway();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetFpxGateway();
});

describe("MolpayFpxGateway.initiate", () => {
  it("builds the hosted-page redirect with a correct vcode", async () => {
    const gw = new MolpayFpxGateway();
    const orderid = "b".repeat(32);
    const { redirectUrl } = await gw.initiate({
      providerTxnId: orderid,
      amount: "1250.00",
      description: "KAEN portal payment",
      returnUrl: "/portal/payments",
    });
    const url = new URL(redirectUrl);
    // The host the `caroonsoft_Dev` account has actually been tested against.
    // Fiuu's docs say pay.fiuu.com superseded this in 2021 — but MOLPAY_BASE_URL
    // is unset in every deploy, so this default IS the live checkout URL, and a
    // passing live transaction outranks a changelog line.
    expect(url.origin).toBe("https://www.onlinepayment.com.my");
    expect(url.pathname).toBe(`/MOLPay/pay/${MID}/`);
    expect(redirectUrl.startsWith(`https://www.onlinepayment.com.my/MOLPay/pay/${MID}/?`)).toBe(true);
    expect(url.searchParams.get("orderid")).toBe(orderid);
    expect(url.searchParams.get("amount")).toBe("1250.00");
    expect(url.searchParams.get("country")).toBe("MY");
    expect(url.searchParams.get("currency")).toBe("MYR");
    expect(url.searchParams.get("vcode")).toBe(md5(`1250.00${MID}${orderid}${VKEY}`));
  });

  it("shows the tenant's billing details, with fallbacks when absent", async () => {
    const gw = new MolpayFpxGateway();
    const withPayer = await gw.initiate({
      providerTxnId: "t1",
      amount: "10.00",
      description: "d",
      returnUrl: "/r",
      payer: { name: "Ali Tenant", email: "ali@example.test", mobile: "+60123456789" },
    });
    const p1 = new URL(withPayer.redirectUrl).searchParams;
    expect(p1.get("bill_name")).toBe("Ali Tenant");
    expect(p1.get("bill_email")).toBe("ali@example.test");
    expect(p1.get("bill_mobile")).toBe("+60123456789");

    const withoutPayer = await gw.initiate({
      providerTxnId: "t2",
      amount: "10.00",
      description: "d",
      returnUrl: "/r",
    });
    const p2 = new URL(withoutPayer.redirectUrl).searchParams;
    expect(p2.get("bill_name")).toBe("KAEN Tenant");
    expect(p2.get("bill_email")).toBe("");
  });

  it("honours MOLPAY_BASE_URL as the full pay-URL prefix and includes returnurl only when MOLPAY_RETURN_URL is set", async () => {
    // A Fiuu-domain migration is env-only: the prefix carries its own path.
    process.env.MOLPAY_BASE_URL = "https://pay.fiuu.com/RMS";
    const plain = await new MolpayFpxGateway().initiate({
      providerTxnId: "t3", amount: "5.00", description: "d", returnUrl: "/spa",
    });
    const u1 = new URL(plain.redirectUrl);
    expect(u1.origin).toBe("https://pay.fiuu.com");
    expect(u1.pathname).toBe(`/RMS/pay/${MID}/`);
    // The SPA returnUrl must NEVER leak into the gateway request — the SPA
    // cannot receive Fiuu's browser POST.
    expect(u1.searchParams.get("returnurl")).toBeNull();

    process.env.MOLPAY_RETURN_URL = "https://api.example.test/webhooks/fpx/molpay/return";
    const withReturn = await new MolpayFpxGateway().initiate({
      providerTxnId: "t4", amount: "5.00", description: "d", returnUrl: "/spa",
    });
    expect(new URL(withReturn.redirectUrl).searchParams.get("returnurl")).toBe(
      "https://api.example.test/webhooks/fpx/molpay/return",
    );
  });
});

describe("MolpayFpxGateway.verifyCallback", () => {
  it("accepts a correctly-signed success (00) body, and surfaces Fiuu's own tranID", () => {
    const gw = new MolpayFpxGateway();
    const orderid = "c".repeat(32);
    const result = gw.verifyCallback(signedBody({ orderid, status: "00" }), "");
    // providerTxnId is OUR order id; providerTranId is FIUU's transaction id.
    // The latter is surfaced rather than merely consumed by the skey chain
    // because it is the only key with a 180-day requery window (order id: 7
    // days) and it exists nowhere except in the messages Fiuu sends us.
    expect(result).toEqual({
      valid: true,
      providerTxnId: orderid,
      providerTranId: "998877",
      // Surfaced so the caller can perform the comparison the spec requires —
      // the checksum proves the gateway signed this, not that the figures are ours.
      amount: "1250.00",
      currency: "MYR",
      status: "success",
    });
  });

  it("omits providerTranId rather than inventing one when the body carries no tranID", () => {
    const gw = new MolpayFpxGateway();
    const result = gw.verifyCallback(signedBody({ tranID: "" }), "");
    expect(result.valid).toBe(true);
    expect(result.providerTranId).toBeUndefined();
  });

  it("maps 22 to pending and 11 (and unknown codes) to failed", () => {
    const gw = new MolpayFpxGateway();
    expect(gw.verifyCallback(signedBody({ status: "22" }), "").status).toBe("pending");
    expect(gw.verifyCallback(signedBody({ status: "11" }), "").status).toBe("failed");
    expect(gw.verifyCallback(signedBody({ status: "99" }), "").status).toBe("failed");
  });

  it("rejects a tampered amount (skey no longer matches)", () => {
    const gw = new MolpayFpxGateway();
    const body = signedBody({ amount: "1250.00" }).replace("amount=1250.00", "amount=1.00");
    expect(gw.verifyCallback(body, "").valid).toBe(false);
  });

  it("rejects a body signed under a different secret, echoing nothing from it", () => {
    const gw = new MolpayFpxGateway();
    const result = gw.verifyCallback(signedBody({}, "wrong-secret"), "");
    expect(result).toEqual({ valid: false, providerTxnId: "", status: "failed" });
  });

  it("rejects garbage / missing-skey bodies without throwing", () => {
    const gw = new MolpayFpxGateway();
    expect(gw.verifyCallback("", "").valid).toBe(false);
    expect(gw.verifyCallback("not&a=real%body", "").valid).toBe(false);
    expect(gw.verifyCallback(new URLSearchParams({ orderid: "x" }).toString(), "").valid).toBe(false);
  });
});

describe("molpay selector + configuration", () => {
  it("getFpxGateway() returns the molpay adapter when FPX_PROVIDER=molpay", () => {
    process.env.FPX_PROVIDER = "molpay";
    const gw = getFpxGateway();
    expect(gw).toBeInstanceOf(MolpayFpxGateway);
    expect(gw.provider).toBe("molpay");
    // Real adapter must NOT expose the mock's forge seam — the mock-confirm
    // route 404s structurally on a molpay deployment.
    expect(gw.buildSignedCallback).toBeUndefined();
  });

  it("fails at SELECTION (before any Payment row) when MOLPAY_* env is missing", () => {
    process.env.FPX_PROVIDER = "molpay";
    delete process.env.MOLPAY_VERIFY_KEY;
    delete process.env.MOLPAY_SECRET_KEY;
    expect(() => getFpxGateway()).toThrow(/MOLPAY_VERIFY_KEY.*MOLPAY_SECRET_KEY|MOLPAY_/);
    // A later, fixed environment recovers — the failed selection cached nothing.
    process.env.MOLPAY_VERIFY_KEY = VKEY;
    process.env.MOLPAY_SECRET_KEY = SKEY;
    expect(getFpxGateway()).toBeInstanceOf(MolpayFpxGateway);
  });

  it("both adapters carry their provider id for row-stamping", () => {
    expect(new MockFpxGateway().provider).toBe("fpx-mock");
    expect(new MolpayFpxGateway().provider).toBe("molpay");
  });
});

// ── queryStatus — the ACTIVE channel ─────────────────────────────────────────
//
// The safety property under test is that this adapter reports "I could not find
// out" for everything short of a checksum-verified answer. Its caller terminates
// payments on a `failed`, so a misread reply here would kill a live transaction
// while the payer's money is still moving through the bank.

/**
 * A requery reply Fiuu would send, carrying a VALID VrfKey.
 *
 * Emits the spec's `type=0` newline/colon form. It previously used
 * URLSearchParams, i.e. `Key=Value` — a shape the spec does not define for any
 * response, and which only parsed because the adapter carried a query-string
 * fallback. That fallback was unreachable against real Fiuu and mis-split any
 * line containing a timestamp, so it was deleted; these fixtures now describe
 * what the gateway actually sends.
 */
function signedQueryReply(
  fields: { StatCode: string; TranID?: string; OrderID?: string; Amount?: string },
  opts: { keyedByTranId?: boolean; secret?: string } = {},
) {
  const amount = fields.Amount ?? "150.00";
  const tranId = fields.TranID ?? "fiuu-9911";
  const orderId = fields.OrderID ?? "order-1";
  const subject = opts.keyedByTranId ? tranId : orderId;
  const vrf = md5(`${amount}${opts.secret ?? SKEY}${MID}${subject}${fields.StatCode}`);
  return [
    `Amount: ${amount}`,
    `TranID: ${tranId}`,
    `OrderID: ${orderId}`,
    `Domain: ${MID}`,
    "Currency: MYR",
    `StatCode: ${fields.StatCode}`,
    `StatName: ${fields.StatCode === "00" ? "captured" : fields.StatCode === "11" ? "failed" : "Pending"}`,
    `VrfKey: ${vrf}`,
  ].join("\n");
}

function stubFetch(body: string, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => body,
  });
}

describe("MolpayFpxGateway.queryStatus", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("maps a verified 00 to success and surfaces the gateway's tranID", async () => {
    globalThis.fetch = stubFetch(signedQueryReply({ StatCode: "00" })) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    // amount/currency come out too — the poll gets the same comparison material
    // as the push, or the two channels settle the same payment differently.
    expect(r).toEqual({
      ok: true,
      status: "success",
      providerTranId: "fiuu-9911",
      amount: "150.00",
      currency: "MYR",
    });
  });

  it("maps a verified 11 to failed and 22 to pending", async () => {
    const gw = new MolpayFpxGateway();

    globalThis.fetch = stubFetch(signedQueryReply({ StatCode: "11" })) as unknown as typeof fetch;
    expect((await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).ok).toBe(true);
    expect(await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).toMatchObject({ status: "failed" });

    globalThis.fetch = stubFetch(signedQueryReply({ StatCode: "22" })) as unknown as typeof fetch;
    expect(await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).toMatchObject({ status: "pending" });
  });

  it("queries BY TRANSACTION ID when we have one — 180-day retention vs 7 by order id", async () => {
    const fetchSpy = stubFetch(signedQueryReply({ StatCode: "22" }, { keyedByTranId: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", providerTranId: "fiuu-9911", amount: "150.00" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("q_by_tid.php");
    expect(String((init as RequestInit).body)).toContain("txID=fiuu-9911");
  });

  it("falls back to the order-id endpoint when the gateway id is unknown", async () => {
    const fetchSpy = stubFetch(signedQueryReply({ StatCode: "22" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("q_by_oid.php");
    expect(String((init as RequestInit).body)).toContain("oID=order-1");
  });

  // ── everything below must NEVER report a failure ───────────────────────────

  it("a reply signed with the WRONG secret is unverified, NOT failed", async () => {
    globalThis.fetch = stubFetch(
      signedQueryReply({ StatCode: "11" }, { secret: "attacker-key" }),
    ) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "unverified" }));
  });

  it("an unparseable reply is unverified, NOT failed", async () => {
    globalThis.fetch = stubFetch("<html>502 Bad Gateway</html>") as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: false });
    expect(r).not.toMatchObject({ status: "failed" });
  });

  it("an unrecognised StatCode is unverified, NOT failed", async () => {
    globalThis.fetch = stubFetch(
      new URLSearchParams({ StatCode: "97", VrfKey: "whatever" }).toString(),
    ) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "unverified" }));
  });

  it("an HTTP error is transport, NOT failed", async () => {
    globalThis.fetch = stubFetch("", false, 503) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "transport" }));
  });

  it("a network throw is transport, NOT failed", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "transport" }));
  });

  it("signs the request with the VERIFY key over the documented field order", async () => {
    const fetchSpy = stubFetch(signedQueryReply({ StatCode: "22" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    const body = new URLSearchParams(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.get("skey")).toBe(md5(`order-1${MID}${VKEY}150.00`));
    expect(body.get("domain")).toBe(MID);
    expect(body.get("amount")).toBe("150.00");
  });
});

describe("MockFpxGateway.queryStatus", () => {
  it("declines to answer rather than inventing a bank result", async () => {
    const gw = new MockFpxGateway();
    expect(await gw.queryStatus()).toEqual({ ok: false, reason: "unsupported" });
  });
});

// ── The reply format Fiuu ACTUALLY sends ─────────────────────────────────────
//
// The queryStatus tests above build their fixture with URLSearchParams, i.e.
// `Key=Value` — the shape the parser already understood. That validated the
// parser against itself and hid a defect that made the entire requery channel
// inert: Fiuu's default reply is newline-separated `Key: Value`, which matched
// neither parser branch, so every requery returned "unverified" and the sweep
// resolved nothing, ever. These fixtures follow the spec's own example response.

/** Fiuu's DEFAULT (type=0) plain-text reply, carrying a valid VrfKey. */
function colonReply(
  fields: { StatCode: string; TranID?: string; OrderID?: string; Amount?: string },
  opts: { keyedByTranId?: boolean } = {},
) {
  const amount = fields.Amount ?? "150.00";
  const tranId = fields.TranID ?? "10645406";
  const orderId = fields.OrderID ?? "order-1";
  const subject = opts.keyedByTranId ? tranId : orderId;
  const vrf = md5(`${amount}${SKEY}${MID}${subject}${fields.StatCode}`);
  return [
    `StatCode: ${fields.StatCode}`,
    "StatName: captured",
    `TranID: ${tranId}`,
    `Amount: ${amount}`,
    `Domain: ${MID}`,
    `VrfKey: ${vrf}`,
    "Channel: fpx",
    `OrderID: ${orderId}`,
    "Currency: MYR",
    // Two extra colons — the reason to split on the FIRST colon only. Fiuu's own
    // WooCommerce plugin uses an unbounded explode(':') and truncates this field.
    "BillingDate: 2026-08-16 10:30:45",
    "ErrorCode:",
    "ErrorDesc:",
  ].join("\n");
}

describe("MolpayFpxGateway.queryStatus — Fiuu's real reply format", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads the default newline/colon reply — the format that made requery inert", async () => {
    globalThis.fetch = stubFetch(colonReply({ StatCode: "00" })) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toEqual({
      ok: true,
      status: "success",
      providerTranId: "10645406",
      amount: "150.00",
      currency: "MYR",
    });
  });

  it("maps 11 and 22 from the colon format too", async () => {
    const gw = new MolpayFpxGateway();

    globalThis.fetch = stubFetch(colonReply({ StatCode: "11" })) as unknown as typeof fetch;
    expect(await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).toMatchObject({ status: "failed" });

    globalThis.fetch = stubFetch(colonReply({ StatCode: "22" })) as unknown as typeof fetch;
    expect(await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).toMatchObject({ status: "pending" });
  });

  it("still rejects a colon reply whose VrfKey does not verify", async () => {
    const bad = colonReply({ StatCode: "00" }).replace(/VrfKey: \w+/, "VrfKey: deadbeef");
    globalThis.fetch = stubFetch(bad) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    expect(await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" })).toEqual(
      expect.objectContaining({ ok: false, reason: "unverified" }),
    );
  });

  it("queries q_by_tid at /RMS/, NOT /RMS/query/ — the path that was 404ing", async () => {
    // The asymmetry is in the spec: q_by_tid sits at /RMS/, q_by_oid at
    // /RMS/query/. tid is preferred whenever we know the gateway's own id, so the
    // wrong segment was hitting the common case.
    const fetchSpy = stubFetch(colonReply({ StatCode: "22" }, { keyedByTranId: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", providerTranId: "10645406", amount: "150.00" });

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/RMS/q_by_tid.php");
    expect(url).not.toContain("/RMS/query/q_by_tid.php");
  });

  it("keeps q_by_oid under /RMS/query/", async () => {
    const fetchSpy = stubFetch(colonReply({ StatCode: "22" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(String(fetchSpy.mock.calls[0][0])).toContain("/RMS/query/q_by_oid.php");
  });

  // ── The reply must be about the transaction we ASKED about ─────────────────
  //
  // The checksum subject is read out of the REPLY, so on its own it proves only
  // "a correctly-signed answer about SOME transaction" — the reply got to choose
  // which one, and its outcome was then applied to OUR payment (the sweep passes
  // our providerTxnId into applyVerifiedFpxOutcome regardless of what came back).
  // On the q_by_oid path the reply's TranID is additionally persisted write-once
  // as this payment's only 180-day requery key, so a wrong one mis-keys it
  // permanently.

  it("refuses a q_by_tid reply that answers about a DIFFERENT transaction", async () => {
    // Correctly checksummed — for transaction 99999999, which is not the one we
    // asked about. Verifying it would apply 99999999's outcome to our payment.
    const foreign = colonReply({ StatCode: "11", TranID: "99999999" }, { keyedByTranId: true });
    globalThis.fetch = stubFetch(foreign) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", providerTranId: "10645406", amount: "150.00" });

    expect(r).toMatchObject({ ok: false, reason: "unverified" });
  });

  it("refuses a q_by_oid reply that answers about a different order", async () => {
    const foreign = colonReply({ StatCode: "11", OrderID: "someone-elses-order" });
    globalThis.fetch = stubFetch(foreign) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: false, reason: "unverified" });
  });

  it("does NOT reject the right transaction over casing or whitespace", async () => {
    // Tolerant on FORMAT, strict on IDENTITY — the same discipline the callback
    // path uses. A false negative here silently stops the sweep resolving rows.
    const padded = colonReply({ StatCode: "00", OrderID: "ORDER-1" });
    globalThis.fetch = stubFetch(padded) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: true, status: "success" });
  });

  it("still accepts a reply that omits the identifier entirely", async () => {
    // Absent is not "different": the subject already falls back to the key we
    // queried, so this check can only ever reject a reply that NAMED another
    // transaction. Anything else would be a new way for the sweep to go inert.
    const noOrderId = colonReply({ StatCode: "00" })
      .split("\n")
      .filter((l) => !l.startsWith("OrderID:"))
      .join("\n");
    globalThis.fetch = stubFetch(noOrderId) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: true, status: "success" });
  });
});

describe("MolpayFpxGateway.verifyCallback — the claim must be ours", () => {
  it("rejects a validly-signed body naming a DIFFERENT merchant", () => {
    // The secret is per-ACCOUNT and that account is shared surface — the portal's
    // own Check button and any other project on the profile sign with it. A body
    // signed with it but naming another merchant is not ours to act on.
    const gw = new MolpayFpxGateway();
    expect(gw.verifyCallback(signedBody({ domain: "someone_else_Dev" }), "").valid).toBe(false);
  });

  it("does NOT reject our own merchant over casing or whitespace", () => {
    // This check was added to a callback path that already worked end-to-end. An
    // exact string compare would turn a stray space or a differently-cased env
    // var into a rejected callback — 400, no ack, one of Fiuu's three retries
    // burned, and eventually a debited payer with nothing recorded. The check is
    // for a DIFFERENT merchant; case and padding carry no signal.
    const gw = new MolpayFpxGateway();
    for (const variant of [MID.toUpperCase(), MID.toLowerCase(), ` ${MID} `]) {
      expect(
        gw.verifyCallback(signedBody({ domain: variant }), "").valid,
        `domain "${variant}" should still be accepted`,
      ).toBe(true);
    }
  });

  it("surfaces amount and currency so the caller can compare them", () => {
    // The signature proves origin, not intent. Without these the caller cannot
    // tell a RM1250 payment from a RM0.01 claim against the same order id.
    const gw = new MolpayFpxGateway();
    const r = gw.verifyCallback(signedBody({ amount: "1250.00" }), "");
    expect(r.amount).toBe("1250.00");
    expect(r.currency).toBe("MYR");
  });

  it("surfaces an EMPTY amount as \"\", never as undefined", () => {
    // The caller's guard skips when `amount` is `undefined` (meaning "this
    // channel does not report figures"). Collapsing "" to undefined therefore
    // handed the exact actor the guard targets a one-parameter bypass: send
    // `amount=` and the comparison disappears. The skey chain hashes whatever is
    // present, so an empty amount signs perfectly well.
    const gw = new MolpayFpxGateway();
    const r = gw.verifyCallback(signedBody({ amount: "" }), "");
    expect(r.valid).toBe(true);
    expect(r.amount).toBe("");
    expect(r.amount).not.toBeUndefined();
  });
});

describe("MolpayFpxGateway.queryStatus — figures and parsing robustness", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("carries amount and currency out of a colon reply", async () => {
    globalThis.fetch = stubFetch(colonReply({ StatCode: "00" })) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: true, status: "success", amount: "150.00", currency: "MYR" });
  });

  it("survives an '=' inside a value — one URL used to break the whole reply", async () => {
    // The branch was chosen by testing the WHOLE body for "=", so a single "="
    // anywhere threw a perfectly good colon reply into the query-string parser.
    // The map then came back non-empty with garbage keys, and the caller reported
    // "not_found" — "the gateway has no record" — for a reply saying StatCode: 00.
    const withEquals = `${colonReply({ StatCode: "00" })}\nMisc: ref=abc123`;
    globalThis.fetch = stubFetch(withEquals) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: true, status: "success" });
  });

  it("surfaces an ABSENT Currency line as \"\" — the caller decides, not the parser", async () => {
    // Every other requery fixture in this file supplies both figures, so nothing
    // here could catch an off-spec reply that omits one. The parser's job is to
    // report faithfully; deciding whether "" is acceptable belongs to the
    // comparison in applyVerifiedFpxOutcome, which treats it as a mismatch.
    const noCurrency = colonReply({ StatCode: "00" })
      .split("\n")
      .filter((l) => !l.startsWith("Currency:"))
      .join("\n");
    globalThis.fetch = stubFetch(noCurrency) as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    const r = await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(r).toMatchObject({ ok: true, status: "success", currency: "" });
  });

  it("does not request type=2 — type=0 is the documented default and `type` is obsoleted for q_by_tid", async () => {
    // NOT because JSON would break the checksum: the spec's JSON sample quotes
    // the amount ("Amount": "3899.00"), so the decimal survives. The reason is
    // that asking for a format which may be ignored, when the default is the one
    // this parser is written and tested against, buys nothing.
    const fetchSpy = stubFetch(colonReply({ StatCode: "22" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const gw = new MolpayFpxGateway();

    await gw.queryStatus({ providerTxnId: "order-1", amount: "150.00" });

    expect(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).not.toContain("type=2");
  });
});

describe("the default hosted-page host is the TESTED one", () => {
  // This default is not a documentation question — it is the live checkout URL,
  // because MOLPAY_BASE_URL is set in no deploy. It was once "modernised" to
  // pay.fiuu.com purely on the strength of the spec's changelog, silently
  // re-pointing a proven-working checkout (and changing the path with it) at a
  // host nobody had put a payment through. This test exists to make that a
  // deliberate act rather than a tidy-up.
  it("defaults to the host a real payment has succeeded against", async () => {
    const { redirectUrl } = await new MolpayFpxGateway().initiate({
      providerTxnId: "x".repeat(32),
      amount: "10.00",
      description: "d",
      returnUrl: "/r",
    });
    expect(new URL(redirectUrl).origin).toBe("https://www.onlinepayment.com.my");
  });

  it("moves hosts by CONFIG, so a migration can be tested before it is adopted", async () => {
    // The documented migration path: point one environment at pay.fiuu.com, put a
    // real payment through, and only then change the default above.
    process.env.MOLPAY_BASE_URL = "https://pay.fiuu.com/RMS";
    const { redirectUrl } = await new MolpayFpxGateway().initiate({
      providerTxnId: "y".repeat(32),
      amount: "10.00",
      description: "d",
      returnUrl: "/r",
    });
    const url = new URL(redirectUrl);
    expect(url.origin).toBe("https://pay.fiuu.com");
    expect(url.pathname).toBe(`/RMS/pay/${MID}/`);
  });
});
