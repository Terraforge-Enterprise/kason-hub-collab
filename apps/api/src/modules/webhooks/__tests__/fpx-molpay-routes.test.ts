/**
 * Route-level tests for the Fiuu (MOLPay) webhook endpoints — DB-free: every
 * case here resolves BEFORE any repository call (flag gate, signature gate, or
 * the pending short-circuit), so no DATABASE_URL is needed. The settle path
 * itself is covered by the fpx-callback integration suite.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resetFpxGateway } from "../../../lib/fpx";
import { mountFpxWebhook } from "../fpx.routes";

const MID = "test_Dev";
const VKEY = "vk-0123-verify";
const SKEY = "sk-4567-secret";

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function signedBody(overrides: Partial<Record<string, string>> = {}): string {
  const f = {
    tranID: "112233",
    orderid: "d".repeat(32),
    status: "00",
    domain: MID,
    amount: "88.00",
    currency: "MYR",
    appcode: "APPX",
    paydate: "2026-08-06 11:00:00",
    ...overrides,
  };
  const key0 = md5(`${f.tranID}${f.orderid}${f.status}${f.domain}${f.amount}${f.currency}`);
  const skey = md5(`${f.paydate}${f.domain}${key0}${f.appcode}${SKEY}`);
  return new URLSearchParams({ ...f, skey }).toString();
}

const ENV_KEYS = [
  "ENABLE_PHASE2_FPX",
  "FPX_PROVIDER",
  "MOLPAY_MERCHANT_ID",
  "MOLPAY_VERIFY_KEY",
  "MOLPAY_SECRET_KEY",
  "APP_WEB_ORIGIN",
] as const;
const saved: Record<string, string | undefined> = {};

function buildApp(): Hono {
  const app = new Hono();
  mountFpxWebhook(app, { prisma: null });
  return app;
}

function post(app: Hono, path: string, body: string) {
  return app.request(path, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ENABLE_PHASE2_FPX = "true";
  process.env.FPX_PROVIDER = "molpay";
  process.env.MOLPAY_MERCHANT_ID = MID;
  process.env.MOLPAY_VERIFY_KEY = VKEY;
  process.env.MOLPAY_SECRET_KEY = SKEY;
  process.env.APP_WEB_ORIGIN = "https://uat-workspace.example.test";
  resetFpxGateway();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetFpxGateway();
});

describe("POST /webhooks/fpx/molpay/notify", () => {
  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await post(buildApp(), "/webhooks/fpx/molpay/notify", signedBody());
    expect(res.status).toBe(404);
  });

  it("rejects an unverifiable body with 400 and NO ack token", async () => {
    const res = await post(buildApp(), "/webhooks/fpx/molpay/notify", "orderid=x&status=00&skey=forged");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("CBTOKEN");
  });

  it("answers a GET probe (portal Check button / uptime monitor) with 200 OK", async () => {
    const res = await buildApp().request("/webhooks/fpx/molpay/notify");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("404s a GET probe while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await buildApp().request("/webhooks/fpx/molpay/notify");
    expect(res.status).toBe(404);
  });

  it("rejects an oversized body before parsing or hashing it", async () => {
    // These routes are public and unauthenticated, and the body has to be parsed
    // and MD5'd before we can know whether it is genuine — so the work is done
    // for an attacker as readily as for Fiuu. A real notification is a form POST
    // of a few hundred bytes.
    //
    // Deliberately NOT a rate limiter: Fiuu sends three retries at 15-minute
    // intervals and then stops forever, so a limiter that drops one is a lost
    // money event.
    const huge = `orderid=x&status=00&pad=${"A".repeat(100_000)}`;
    const res = await post(buildApp(), "/webhooks/fpx/molpay/notify", huge);

    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("CBTOKEN");
  });

  it("still accepts a normal-sized signed body", async () => {
    // The cap must have enough headroom that no genuine notification is near it.
    const res = await post(buildApp(), "/webhooks/fpx/molpay/notify", signedBody({ status: "22" }));
    expect(res.status).toBe(200);
  });

  it("acks a signed PENDING (22) with CBTOKEN:MPSTATOK and touches nothing", async () => {
    // Pending short-circuits before the payment lookup — this test runs with no
    // database at all, which is itself the proof of "no state change".
    const res = await post(buildApp(), "/webhooks/fpx/molpay/notify", signedBody({ status: "22" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CBTOKEN:MPSTATOK");
  });
});

describe("/webhooks/fpx/molpay/return", () => {
  it("bounces the payer to the portal even when the body is unverifiable", async () => {
    const res = await post(buildApp(), "/webhooks/fpx/molpay/return", "garbage=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://uat-workspace.example.test/portal/payments");
  });

  it("REDIRECTS an oversized body rather than 413-ing a payer's browser", async () => {
    // Same cap as the notify route, different answer: a tenant's browser must
    // never dead-end on a webhook error, and the portal page it lands on reads
    // real state from the API anyway.
    const huge = `orderid=x&status=00&pad=${"A".repeat(100_000)}`;
    const res = await post(buildApp(), "/webhooks/fpx/molpay/return", huge);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://uat-workspace.example.test/portal/payments");
  });

  it("bounces a GET revisit the same way", async () => {
    const res = await buildApp().request("/webhooks/fpx/molpay/return");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://uat-workspace.example.test/portal/payments");
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await post(buildApp(), "/webhooks/fpx/molpay/return", signedBody());
    expect(res.status).toBe(404);
  });

  it("tells a payer whose payment was PARKED that it is pending, not received", async () => {
    // The banner used to be derived from the raw gateway status, so a signed
    // success that could not be applied — figures not matching ours, or a row a
    // human had already closed — still showed "Your payment was received."
    // That is a promise we have not kept: their charge is still open and nobody
    // has applied anything. It now reflects what the handler actually DID.
    //
    // A `22` (pending) body reaches the redirect without touching the database,
    // which is what keeps this case DB-free — and pending is exactly the state a
    // parked payment is shown as, so it pins the same branch the parked path uses.
    const res = await post(buildApp(), "/webhooks/fpx/molpay/return", signedBody({ status: "22" }));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://uat-workspace.example.test/portal/payments?fpx=pending",
    );
  });
});
