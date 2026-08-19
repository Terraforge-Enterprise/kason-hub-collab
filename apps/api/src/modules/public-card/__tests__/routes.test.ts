// Integration tests for the public-card routes (per spec §9.8).
//
// Coverage:
//   - 404 body parity for ALL failure reasons (bad token, flag off, unknown
//     token) — the response body MUST be identical so attackers cannot
//     side-channel "found vs not found" via response shape (per §9.8 #24).
//   - Happy-path response includes ONLY the whitelisted top-level keys (DTO
//     leak-guard belongs to dto-leak-guard.test.ts; this only checks shape).
//   - Required cache + privacy headers on 200.
//   - Per-IP rate limit: 60/min/IP, 61st request returns 429.
//
// Why we mock `../service`:
//   The route layer does NOT need the real DB to verify gating. The leak-
//   guard test already binds the DTO contract. Mocking the service keeps
//   this test fast and hermetic and means we don't need to provision the
//   DATABASE_URL_READONLY connection just to test routes.
//
// Why we mock `../../../lib/runtime-config`:
//   `runtimeConfig.publicCard.featureEnabled` is read ONCE at import time
//   from process.env. Setting `process.env.FEATURE_AGENT_NAMECARD` in a
//   beforeEach has no effect because the module value is already frozen.
//   Mocking the export with a getter lets us flip the flag per-test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoisted mock state ─────────────────────────────────────────────────────
const { mockGetPublicCardByToken, mockFeatureFlag } = vi.hoisted(() => ({
  mockGetPublicCardByToken: vi.fn(),
  mockFeatureFlag: { value: true },
}));

vi.mock("../service", () => ({
  getPublicCardByToken: mockGetPublicCardByToken,
}));

vi.mock("../../../lib/runtime-config", () => ({
  runtimeConfig: {
    publicCard: {
      get featureEnabled() {
        return mockFeatureFlag.value;
      },
      supabasePublicBucketUrl: "https://test.supabase.co",
      databaseUrlReadonly: undefined,
    },
  },
}));

import { Hono } from "hono";
import { publicCardRoutes } from "../routes";
import { _resetPublicCardBucketForTests } from "../rate-limit";

function makeApp() {
  const app = new Hono();
  app.route("/public-api/card", publicCardRoutes);
  return app;
}

// Canonical happy-path DTO. Shape mirrors PublicCardDto so callers can
// assert top-level keys without hand-rolling the full payload.
const validDto = {
  displayName: "Kason Khoo",
  title: "Founder",
  primaryEmail: "kason@example.com",
  primaryPhone: "012-3828967",
  whatsappPhone: "60123828967",
  org: {
    agencyName: "EUM Realty",
    agencyLicense: "E(1) 1708",
    agencyPhone: null,
    agencyFax: null,
    address: ["Line 1", "Line 2"],
    logoUrl: "/logo-gold.png",
  },
  listings: [],
  expiresAt: "2026-08-05T00:00:00.000Z",
};

const VALID_TOKEN = "AbCdEfGhIjKlMnOpQrStUv"; // 22 chars, base64url alphabet

beforeEach(() => {
  vi.clearAllMocks();
  // Reset rate-limit bucket so a 429 from a previous test doesn't bleed in.
  _resetPublicCardBucketForTests();
  // Default: flag ON, service returns the canonical happy DTO. Individual
  // tests override these as needed.
  mockFeatureFlag.value = true;
  mockGetPublicCardByToken.mockResolvedValue(validDto);
});

afterEach(() => {
  _resetPublicCardBucketForTests();
});

// Per-test IP header so the rate-limit bucket doesn't leak across tests
// even though we already reset it. Matches the rate-limit module's
// clientIp() lookup order.
function reqHeaders(ip = "10.0.0.1") {
  return { "x-forwarded-for": ip };
}

describe("public-card routes — 404 parity", () => {
  it("rejects token shape — 21 chars — service returns null", async () => {
    // The REAL service runs the regex; the mocked one returns null when
    // wired to. Either way, the route MUST surface the canonical 404.
    // (The shape gate lives in service.ts — see service tests; this test
    // binds the route-layer contract that null → 404.)
    mockGetPublicCardByToken.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("/public-api/card/AbCdEfGhIjKlMnOpQrStU", {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("rejects token shape — special chars — service returns null", async () => {
    mockGetPublicCardByToken.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("/public-api/card/!@#$%abcdefghijklmnopqr", {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 (no service call) when feature flag is off, even with a valid token", async () => {
    mockFeatureFlag.value = false;
    const app = makeApp();
    const res = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockGetPublicCardByToken).not.toHaveBeenCalled();
  });

  it("returns 404 with identical body when service returns null (unknown token)", async () => {
    mockGetPublicCardByToken.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns IDENTICAL 404 body for flag-off vs shape-fail vs unknown-token", async () => {
    // Three independent failure reasons must produce byte-identical bodies.
    const app = makeApp();

    mockFeatureFlag.value = false;
    const r1 = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders("10.0.0.10"),
    });
    const b1 = await r1.text();

    mockFeatureFlag.value = true;
    mockGetPublicCardByToken.mockResolvedValue(null); // would happen for bad shape
    const r2 = await app.request("/public-api/card/short", {
      headers: reqHeaders("10.0.0.11"),
    });
    const b2 = await r2.text();

    mockGetPublicCardByToken.mockResolvedValue(null); // unknown token
    const r3 = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders("10.0.0.12"),
    });
    const b3 = await r3.text();

    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r3.status).toBe(404);
    expect(b1).toBe(b2);
    expect(b2).toBe(b3);
  });
});

describe("public-card routes — happy path", () => {
  it("returns 200 with exactly the whitelisted top-level keys", async () => {
    const app = makeApp();
    const res = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "displayName",
        "title",
        "primaryEmail",
        "primaryPhone",
        "whatsappPhone",
        "org",
        "listings",
        "expiresAt",
      ].sort(),
    );
    expect(mockGetPublicCardByToken).toHaveBeenCalledWith(VALID_TOKEN);
  });

  it("sets cache + privacy response headers per spec §9.8", async () => {
    const app = makeApp();
    const res = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("public-card routes — rate limiting", () => {
  it("allows 60 requests / 60s / IP and rejects the 61st with 429", async () => {
    const app = makeApp();
    const ip = "10.0.0.42";
    const headers = reqHeaders(ip);

    // 60 valid requests should all succeed (200).
    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/public-api/card/${VALID_TOKEN}`, {
        headers,
      });
      expect(res.status).toBe(200);
    }

    // 61st must be rate-limited.
    const limited = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("rate-limit is per-IP (different IP after the limit still succeeds)", async () => {
    const app = makeApp();
    const ip1 = "10.0.0.50";

    // Burn IP1's quota.
    for (let i = 0; i < 60; i++) {
      await app.request(`/public-api/card/${VALID_TOKEN}`, {
        headers: reqHeaders(ip1),
      });
    }
    const limited = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders(ip1),
    });
    expect(limited.status).toBe(429);

    // Different IP should NOT be limited.
    const ok = await app.request(`/public-api/card/${VALID_TOKEN}`, {
      headers: reqHeaders("10.0.0.51"),
    });
    expect(ok.status).toBe(200);
  });
});
