import type { CookieOptions } from "hono/utils/cookie";

const isProduction = process.env.NODE_ENV === "production";
const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".kaenproperties.com"

export const portalCookieConfig: CookieOptions = {
  path: "/portal-api",
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "None" : "Lax",
  maxAge: 14400, // 4 hours
  ...(cookieDomain && { domain: cookieDomain }),
};
