import type { CookieOptions } from "hono/utils/cookie";

const isProduction = process.env.NODE_ENV === "production";
const cookieDomain = process.env.COOKIE_DOMAIN; // e.g. ".kaenproperties.com"

export const adminCookieConfig: CookieOptions = {
  path: "/api",
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "None" : "Lax",
  maxAge: 28800, // 8 hours
  ...(cookieDomain && { domain: cookieDomain }),
};
