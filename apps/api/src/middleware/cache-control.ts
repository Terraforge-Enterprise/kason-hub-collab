import { createMiddleware } from "hono/factory";

/**
 * Mark a response as never-cacheable.
 *
 * The admin twin of `portalCacheControl` (modules/portal/portal.middleware.ts:19)
 * — the portal has marked its authenticated responses no-store since it was
 * built; /api/* never got the same treatment because nothing cached it: the SPA
 * talks to the Lightsail origin directly, with no CDN in between.
 *
 * That assumption is what changes. Moving /api/* behind the CloudFront
 * distribution (so the SPA and the API share an origin, and the httpOnly session
 * cookie stops being cross-site — see infra/modules/cdn/main.tf) puts a shared
 * cache in front of authenticated responses for the first time. The behaviour
 * uses the managed CachingDisabled policy, but a cache policy is one setting on
 * one resource, and getting it wrong means CloudFront serves one org's invoices
 * to another org's admin. The origin therefore states it independently: two
 * mechanisms, neither relying on the other being right.
 *
 * Set AFTER next() so it wins over anything a route set for itself.
 */
export const noStore = createMiddleware(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
