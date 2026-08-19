// Public agent-card sub-app (per spec §6.3, §9.1, §9.8).
//
// Hard rules baked into this file:
//   - NO auth middleware. The ESLint guard in apps/api/eslint.config.mjs
//     will block any attempt to import auth/require-role here. Don't try.
//   - 404 path is timing- and body-identical for ALL failure reasons:
//     bad-shape token, unknown token, expired version, non-approved
//     version, inactive party, inactive org. Constant 50ms minimum
//     response time prevents token-existence side-channel leaks.
//   - Successful response carries the cache + privacy headers from the
//     spec; CloudFront caches successes for 5 min.
//   - The whole sub-app is gated by FEATURE_AGENT_NAMECARD; while off,
//     even the happy path returns the canonical 404.

import { Hono } from "hono";
import type { Context } from "hono";
import { runtimeConfig } from "../../lib/runtime-config";
import { getPublicCardByToken } from "./service";
import { rateLimitByIp } from "./rate-limit";

// Constant minimum response time on the 404 path (per spec §9.8 #24).
// 50ms covers the typical happy-path latency so attackers cannot infer
// "found vs not found" from response timing.
const NOT_FOUND_MIN_DELAY_MS = 50;

async function notFound(c: Context) {
  await new Promise((res) => setTimeout(res, NOT_FOUND_MIN_DELAY_MS));
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ error: "not_found" }, 404);
}

export const publicCardRoutes = new Hono();

publicCardRoutes.use("*", rateLimitByIp);

publicCardRoutes.get("/:token", async (c) => {
  // Feature flag gate. While the namecard module is dark, every request
  // through the sub-app returns the canonical 404 — no shape leak about
  // whether the route exists or what the gate is.
  if (!runtimeConfig.publicCard.featureEnabled) {
    return notFound(c);
  }

  const token = c.req.param("token");
  const dto = await getPublicCardByToken(token);
  if (!dto) {
    return notFound(c);
  }

  c.header("Cache-Control", "public, max-age=300, s-maxage=300");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  return c.json(dto);
});
