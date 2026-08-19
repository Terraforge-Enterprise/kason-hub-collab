import type { Context } from "hono";

/**
 * Single source of truth for extracting `{ip, userAgent}` from a Hono
 * request. 10+ route handlers used to inline this pattern; every audit
 * call funnels through these two headers.
 */
export function getActorHeaders(c: Context): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  return {
    ip: c.req.header("x-forwarded-for") ?? undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
  };
}
