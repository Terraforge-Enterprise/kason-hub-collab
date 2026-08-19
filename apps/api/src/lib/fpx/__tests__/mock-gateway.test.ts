import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockFpxGateway } from "../mock-gateway";
import { getFpxGateway, resetFpxGateway } from "../index";

describe("MockFpxGateway.initiate", () => {
  it("returns a redirectUrl that carries the providerTxnId", async () => {
    const gw = new MockFpxGateway();
    const { redirectUrl } = await gw.initiate({
      providerTxnId: "txn-abc-123",
      amount: "1250.00",
      description: "Rent + utilities June",
      returnUrl: "/portal/payments/done",
    });
    expect(redirectUrl).toContain("txn-abc-123");
    expect(redirectUrl).toContain("/portal/fpx/mock");
    expect(redirectUrl).toContain("amount=1250.00");
  });

  it("prefixes the redirectUrl with APP_WEB_ORIGIN when set", async () => {
    const orig = process.env.APP_WEB_ORIGIN;
    process.env.APP_WEB_ORIGIN = "https://app.example.com";
    try {
      const gw = new MockFpxGateway();
      const { redirectUrl } = await gw.initiate({
        providerTxnId: "t1",
        amount: "10.00",
        description: "d",
        returnUrl: "/r",
      });
      expect(redirectUrl).toBe(
        "https://app.example.com/portal/fpx/mock?txn=t1&amount=10.00",
      );
    } finally {
      if (orig === undefined) delete process.env.APP_WEB_ORIGIN;
      else process.env.APP_WEB_ORIGIN = orig;
    }
  });
});

describe("MockFpxGateway callback signing", () => {
  it("verifies a callback it signed itself (success)", () => {
    const gw = new MockFpxGateway();
    const { rawBody, signature } = gw.buildSignedCallback("txn1", "success");
    const result = gw.verifyCallback(rawBody, signature);
    expect(result).toEqual({ valid: true, providerTxnId: "txn1", status: "success" });
  });

  it("verifies a failed-outcome callback", () => {
    const gw = new MockFpxGateway();
    const { rawBody, signature } = gw.buildSignedCallback("txn2", "failed");
    expect(gw.verifyCallback(rawBody, signature)).toEqual({
      valid: true,
      providerTxnId: "txn2",
      status: "failed",
    });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const gw = new MockFpxGateway();
    const { rawBody, signature } = gw.buildSignedCallback("txn1", "failed");
    // Flip the outcome an attacker would want: failed -> success.
    const tampered = rawBody.replace('"failed"', '"success"');
    expect(tampered).not.toBe(rawBody);
    expect(gw.verifyCallback(tampered, signature).valid).toBe(false);
  });

  it("rejects a wrong/garbage signature without throwing", () => {
    const gw = new MockFpxGateway();
    const { rawBody } = gw.buildSignedCallback("txn1", "success");
    // timingSafeEqual throws on length mismatch — these must be caught internally.
    expect(gw.verifyCallback(rawBody, "not-a-real-signature").valid).toBe(false);
    expect(gw.verifyCallback(rawBody, "").valid).toBe(false);
  });

  it("rejects a callback signed under a different secret", () => {
    const orig = process.env.FPX_MOCK_SECRET;
    try {
      process.env.FPX_MOCK_SECRET = "secret-A";
      const signed = new MockFpxGateway().buildSignedCallback("txn1", "success");
      process.env.FPX_MOCK_SECRET = "secret-B";
      const result = new MockFpxGateway().verifyCallback(signed.rawBody, signed.signature);
      expect(result.valid).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.FPX_MOCK_SECRET;
      else process.env.FPX_MOCK_SECRET = orig;
    }
  });
});

describe("getFpxGateway selector", () => {
  const orig = { provider: process.env.FPX_PROVIDER, nodeEnv: process.env.NODE_ENV };

  beforeEach(() => {
    resetFpxGateway();
    delete process.env.FPX_PROVIDER;
  });

  afterEach(() => {
    resetFpxGateway();
    if (orig.provider === undefined) delete process.env.FPX_PROVIDER;
    else process.env.FPX_PROVIDER = orig.provider;
    if (orig.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = orig.nodeEnv;
  });

  it("returns the mock when FPX_PROVIDER is unset (non-prod)", () => {
    expect(getFpxGateway()).toBeInstanceOf(MockFpxGateway);
  });

  it("returns the mock when FPX_PROVIDER=mock", () => {
    process.env.FPX_PROVIDER = "mock";
    expect(getFpxGateway()).toBeInstanceOf(MockFpxGateway);
  });

  it("memoizes the instance across calls", () => {
    expect(getFpxGateway()).toBe(getFpxGateway());
  });

  it("resetFpxGateway() clears the memoized instance", () => {
    const first = getFpxGateway();
    resetFpxGateway();
    expect(getFpxGateway()).not.toBe(first);
  });

  it("throws for an unconfigured real provider", () => {
    process.env.FPX_PROVIDER = "senangpay";
    expect(() => getFpxGateway()).toThrow(/senangpay|configured|available/i);
  });

  it("refuses to default to the mock in production when unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FPX_PROVIDER;
    expect(() => getFpxGateway()).toThrow(/production|FPX_PROVIDER/i);
  });
});
