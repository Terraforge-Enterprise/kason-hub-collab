// Per-IP rate limiter for the public-card endpoint (per spec §9.5 #16).
//
// 60 requests / 60s / IP. Reuses the shared per-key counter helper at
// `apps/api/src/lib/rate-limit.ts` (same fixed-window semantics; we don't
// need a true token-bucket for a 1 RPS-average ceiling).
//
// SINGLE-REPLICA ASSUMPTION: the bucket lives in-process. The current
// Lightsail container service runs ONE replica, so per-IP limits are
// global per-instance. If the deployment ever scales to ≥2 replicas the
// limiter is no longer correct — switch to Redis or a Lightsail-managed
// equivalent. The bucket evaporates on container restart (accepted: worst
// case the rate-limit window resets on each deploy).

import type { Context, MiddlewareHandler } from "hono";
import {
  type RateLimitBucket,
  checkPerKey,
} from "../../lib/rate-limit";

const PUBLIC_CARD_BUCKET: RateLimitBucket = new Map();
const MAX_REQUESTS_PER_WINDOW = 60;
const WINDOW_MS = 60_000;

function clientIp(c: Context): string {
  // CloudFront forwards the original client IP in CF-Connecting-IP. Behind
  // any reverse proxy (nginx, Lightsail load balancer) the X-Forwarded-For
  // chain is the fallback. Worst case (direct access in dev) we fall back
  // to a constant — fine because dev traffic doesn't need real isolation.
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export const rateLimitByIp: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c);
  const result = checkPerKey(
    PUBLIC_CARD_BUCKET,
    ip,
    MAX_REQUESTS_PER_WINDOW,
    WINDOW_MS,
  );
  if (!result.ok) {
    c.header("Retry-After", String(result.retryAfter));
    return c.json({ error: "rate_limited" }, 429);
  }
  await next();
};

// Test-only export — lets integration tests reset the in-memory bucket
// between cases without leaking across test files.
export function _resetPublicCardBucketForTests(): void {
  PUBLIC_CARD_BUCKET.clear();
}
