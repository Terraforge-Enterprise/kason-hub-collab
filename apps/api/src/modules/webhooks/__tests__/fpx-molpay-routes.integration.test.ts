/**
 * Integration test for the Fiuu notify route's unknown-orderid ack — needs a
 * real DB because a VALID signature proceeds to the payment lookup. This is the
 * exact shape of the Fiuu portal's "Check" button: a random transaction signed
 * with the account's real secret key. It must be acked (CBTOKEN, 200), settle
 * nothing, and create nothing.
 *
 * Run:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://...localhost..." \
 *     npx vitest run src/modules/webhooks/__tests__/fpx-molpay-routes.integration
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { getDb } from "@kason/db";
import { resetFpxGateway } from "../../../lib/fpx";
import { mountFpxWebhook } from "../fpx.routes";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const MID = "test_Dev";
const SKEY = "sk-4567-secret";

function md5(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function signedUnknownTxnBody(): string {
  const f = {
    tranID: "445566",
    orderid: crypto.randomUUID().replace(/-/g, ""),
    status: "00",
    domain: MID,
    amount: "9.99",
    currency: "MYR",
    appcode: "APPZ",
    paydate: "2026-08-06 16:31:06",
  };
  const key0 = md5(`${f.tranID}${f.orderid}${f.status}${f.domain}${f.amount}${f.currency}`);
  const skey = md5(`${f.paydate}${f.domain}${key0}${f.appcode}${SKEY}`);
  return new URLSearchParams({ ...f, skey }).toString();
}

const ENV_KEYS = ["ENABLE_PHASE2_FPX", "FPX_PROVIDER", "MOLPAY_MERCHANT_ID", "MOLPAY_VERIFY_KEY", "MOLPAY_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

dn("POST /webhooks/fpx/molpay/notify — verified but unknown orderid (the portal Check button)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENABLE_PHASE2_FPX = "true";
    process.env.FPX_PROVIDER = "molpay";
    process.env.MOLPAY_MERCHANT_ID = MID;
    process.env.MOLPAY_VERIFY_KEY = "vk-0123-verify";
    process.env.MOLPAY_SECRET_KEY = SKEY;
    resetFpxGateway();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetFpxGateway();
  });

  it("acks with CBTOKEN:MPSTATOK, settles nothing, creates nothing", async () => {
    const db = getDb();
    const app = new Hono();
    mountFpxWebhook(app, { prisma: null });

    const before = await db.payment.count();
    const res = await app.request("/webhooks/fpx/molpay/notify", {
      method: "POST",
      body: signedUnknownTxnBody(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CBTOKEN:MPSTATOK");
    expect(await db.payment.count()).toBe(before);
  });
});
