import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { rateLimiter } from "hono-rate-limiter";
import { runtimeConfig } from "../../lib/runtime-config";

export const portalCsrf = csrf({
  origin: (origin) => {
    const allowed = runtimeConfig.corsOrigins;
    if (allowed === "*") return true;
    return allowed.includes(origin);
  },
});

export const portalCsrfIfCookie = createMiddleware(async (c, next) => {
  if (c.get("authMethod") === "bearer") return next();
  return portalCsrf(c, next);
});

export const portalCacheControl = createMiddleware(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// IP-based brute-force defence. Carrier-grade NAT and shared office Wi-Fi
// both expose multiple agents under a single x-forwarded-for, so the limit
// must be high enough to absorb concurrent legitimate use; 20/15min still
// bounds a serious attacker tightly when combined with the per-email cap
// inside the route. The handler returns retryAfter so the login form can
// show a live countdown — the Retry-After header is also set automatically
// but isn't CORS-exposed by default.
export const portalLoginRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
  handler: (c) => {
    // hono-rate-limiter stashes its info under "rateLimit"; the Hono Variables
    // generic doesn't know about it, so cast through unknown.
    const info = (c as unknown as { get: (k: string) => unknown }).get(
      "rateLimit",
    ) as { resetTime?: Date } | undefined;
    const retryAfter = info?.resetTime
      ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
      : 900;
    return c.json(
      {
        error: "Too many login attempts from this network. Please try again later.",
        retryAfter,
      },
      429,
    );
  },
});

export const portalClaimCreateLimiter = rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 10,
  keyGenerator: (c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (c as any).get("session") as { partyId?: string } | undefined;
    return session?.partyId ?? c.req.header("x-forwarded-for") ?? "unknown";
  },
});

export const portalClaimSubmitLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: (c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (c as any).get("session") as { partyId?: string } | undefined;
    return session?.partyId ?? c.req.header("x-forwarded-for") ?? "unknown";
  },
});

export function portalUserTypeGuard(...allowed: string[]) {
  return createMiddleware(async (c, next) => {
    const session = c.get("session") as { userType?: string } | undefined;
    if (!session?.userType || !allowed.includes(session.userType)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  });
}
