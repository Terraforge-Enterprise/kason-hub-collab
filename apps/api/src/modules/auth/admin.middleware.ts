import { csrf } from "hono/csrf";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { runtimeConfig } from "../../lib/runtime-config";

export const adminCsrf = csrf({
  origin: (origin) => {
    const allowed = runtimeConfig.corsOrigins;
    if (allowed === "*") return true;
    return allowed.includes(origin);
  },
});

export const adminCsrfIfCookie = createMiddleware(async (c, next) => {
  const hasCookie = !!getCookie(c, "admin_session");
  const hasBearer = c.req.header("Authorization")?.startsWith("Bearer ");
  if (hasCookie && !hasBearer) {
    return adminCsrf(c, next);
  }
  return next();
});
