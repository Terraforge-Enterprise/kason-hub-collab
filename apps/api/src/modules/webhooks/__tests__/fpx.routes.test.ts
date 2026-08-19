/**
 * Tasks 3+4 (sub-project A / FPX) — route-wiring tests for mountFpxWebhook.
 * Mocks the service (and, for mock-confirm, the gateway) to assert the public
 * routes: flag-gating on ENABLE_PHASE2_FPX, the callback's RAW body + signature
 * passthrough, and the mock-confirm endpoint's mock-only guard + server-side
 * signing + outcome mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

vi.mock("../../payments/fpx-callback.service", () => ({ handleFpxCallbackService: vi.fn() }));
vi.mock("../../../lib/fpx", () => ({ getFpxGateway: vi.fn() }));

import { handleFpxCallbackService } from "../../payments/fpx-callback.service";
import { getFpxGateway } from "../../../lib/fpx";
import { mountFpxWebhook } from "../fpx.routes";

const RAW = '{"providerTxnId":"txn-1","status":"success"}';
const SIG = "abc123";

function makeApp(): Hono {
  const app = new Hono();
  mountFpxWebhook(app, { prisma: {} });
  return app;
}

describe("fpx webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_PHASE2_FPX = "1";
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_FPX;
  });

  it("flag OFF → 404 canonical, service NOT called (dark)", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await makeApp().request("/webhooks/fpx/callback", {
      method: "POST",
      body: RAW,
      headers: { "content-type": "application/json", "x-fpx-signature": SIG },
    });
    expect(res.status).toBe(404);
    expect(handleFpxCallbackService).not.toHaveBeenCalled();
  });

  it("flag ON → passes EXACT raw body + signature header to the service; 200 ok", async () => {
    vi.mocked(handleFpxCallbackService).mockResolvedValue({ ok: true, status: 200 });
    const res = await makeApp().request("/webhooks/fpx/callback", {
      method: "POST",
      body: RAW,
      headers: { "content-type": "application/json", "x-fpx-signature": SIG },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(handleFpxCallbackService).toHaveBeenCalledWith(RAW, SIG);
  });

  it("missing signature header → service receives empty string (verify will reject)", async () => {
    vi.mocked(handleFpxCallbackService).mockResolvedValue({ ok: false, status: 400 });
    const res = await makeApp().request("/webhooks/fpx/callback", {
      method: "POST",
      body: RAW,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(handleFpxCallbackService).toHaveBeenCalledWith(RAW, "");
  });

  it("maps a service error status onto the HTTP response (404 → 404)", async () => {
    vi.mocked(handleFpxCallbackService).mockResolvedValue({ ok: false, status: 404 });
    const res = await makeApp().request("/webhooks/fpx/callback", {
      method: "POST",
      body: RAW,
      headers: { "x-fpx-signature": SIG },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("error");
  });
});

describe("fpx mock-confirm route", () => {
  const buildSignedCallback = vi.fn();
  const SIGNED = { rawBody: '{"providerTxnId":"txn-9","status":"success"}', signature: "sig-9" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_PHASE2_FPX = "1";
    buildSignedCallback.mockReturnValue(SIGNED);
    // The in-process mock gateway HAS buildSignedCallback (a real adapter omits it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getFpxGateway).mockReturnValue({ buildSignedCallback } as any);
    vi.mocked(handleFpxCallbackService).mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => {
    delete process.env.ENABLE_PHASE2_FPX;
  });

  async function post(body: unknown): Promise<Response> {
    return makeApp().request("/webhooks/fpx/mock-confirm", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("flag OFF → 404; gateway + service untouched (dark)", async () => {
    delete process.env.ENABLE_PHASE2_FPX;
    const res = await post({ providerTxnId: "txn-9", outcome: "success" });
    expect(res.status).toBe(404);
    expect(buildSignedCallback).not.toHaveBeenCalled();
    expect(handleFpxCallbackService).not.toHaveBeenCalled();
  });

  it("(c) gateway WITHOUT buildSignedCallback (real adapter) → 404, service NOT called", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getFpxGateway).mockReturnValue({ verifyCallback: vi.fn(), initiate: vi.fn() } as any);
    const res = await post({ providerTxnId: "txn-9", outcome: "success" });
    expect(res.status).toBe(404);
    expect(handleFpxCallbackService).not.toHaveBeenCalled();
  });

  it("success → signs 'success' server-side + forwards the signed callback to the service; 200", async () => {
    const res = await post({ providerTxnId: "txn-9", outcome: "success" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(buildSignedCallback).toHaveBeenCalledWith("txn-9", "success");
    expect(handleFpxCallbackService).toHaveBeenCalledWith(SIGNED.rawBody, SIGNED.signature);
  });

  it("failure → maps outcome 'failure' → gateway 'failed' before signing", async () => {
    await post({ providerTxnId: "txn-9", outcome: "failure" });
    expect(buildSignedCallback).toHaveBeenCalledWith("txn-9", "failed");
    expect(handleFpxCallbackService).toHaveBeenCalledWith(SIGNED.rawBody, SIGNED.signature);
  });

  it("missing providerTxnId → 400; nothing signed or forwarded", async () => {
    const res = await post({ outcome: "success" });
    expect(res.status).toBe(400);
    expect(buildSignedCallback).not.toHaveBeenCalled();
    expect(handleFpxCallbackService).not.toHaveBeenCalled();
  });

  it("invalid outcome → 400", async () => {
    const res = await post({ providerTxnId: "txn-9", outcome: "maybe" });
    expect(res.status).toBe(400);
    expect(buildSignedCallback).not.toHaveBeenCalled();
  });

  it("maps the settle service's status onto the response (409 → 409)", async () => {
    vi.mocked(handleFpxCallbackService).mockResolvedValue({ ok: false, status: 409 });
    const res = await post({ providerTxnId: "txn-9", outcome: "success" });
    expect(res.status).toBe(409);
  });
});
