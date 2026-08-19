/**
 * api-response-headers.test.ts
 *
 * Two response-header guarantees that only matter at the EDGE, and that nothing
 * else in the suite covers:
 *
 *  1. The CORS preflight carries Access-Control-Max-Age. Without it browsers fall
 *     back to the Fetch-spec default of 5 SECONDS, so the admin SPA (CloudFront
 *     origin) re-preflights the API (Lightsail origin) on essentially every call
 *     — doubling the request count against a container that serialises under
 *     concurrency. Measured on UAT 2026-08-17: the preflight response carried no
 *     max-age at all.
 *
 *  2. /api/* and /portal-api/* responses are marked no-store. These are the
 *     AUTHENTICATED surfaces. The planned move of /api/* behind the CloudFront
 *     distribution (so the SPA and API share an origin and the httpOnly cookie
 *     stops being cross-site) puts a CACHE in front of authenticated responses
 *     for the first time. The CloudFront behaviour will use the managed
 *     CachingDisabled policy, but that is one checkbox between "correct" and
 *     "serve tenant A's invoices to tenant B" — so the origin states it too.
 *     Defence in depth: the edge must be told twice, by two different mechanisms.
 *
 *     /public-api/* is deliberately EXCLUDED. It is the no-auth public surface
 *     (e-namecard + reservations) and its whole point is to be edge-cached —
 *     infra/modules/cdn/main.tf gives it a cache policy with max_ttl 86400.
 *     Marking it no-store would silently delete that caching.
 *
 * Unit test: uses the @kason/db mock, never connects to Postgres.
 */
import { describe, it, expect } from "vitest";
import { app } from "../../app";

const ORIGIN = "https://uat-workspace.kaenproperties.com";

describe("CORS preflight is cacheable", () => {
  it("sets Access-Control-Max-Age on the preflight", async () => {
    const res = await app.request("/api/billing/invoices?status=draft&limit=200", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });

    const maxAge = res.headers.get("access-control-max-age");
    expect(maxAge).toBeTruthy();
    // Chrome caps at 7200s; anything under ~10 minutes leaves the browser
    // re-asking constantly, which is the bug this guards.
    expect(Number(maxAge)).toBeGreaterThanOrEqual(600);
  });
});

describe("authenticated surfaces are never cacheable", () => {
  it("marks /api/* no-store — even on the unauthenticated 401 path", async () => {
    const res = await app.request("/api/billing/invoices?status=draft", {
      headers: { Origin: ORIGIN },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("marks /portal-api/* no-store", async () => {
    const res = await app.request("/portal-api/me", { headers: { Origin: ORIGIN } });

    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
  });

  it("leaves /public-api/* cacheable — it is deliberately edge-cached", async () => {
    const res = await app.request("/public-api/card/some-token", {
      headers: { Origin: ORIGIN },
    });

    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store");
  });

  it("leaves /health cacheable-neutral — it is not an authenticated surface", async () => {
    const res = await app.request("/health");

    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store");
  });
});
