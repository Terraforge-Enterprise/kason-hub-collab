import { Hono } from "hono";
import { z } from "zod";
import { setCookie, deleteCookie } from "hono/cookie";
import { portalLoginSchema } from "@kason/shared";
import { portalLoginService, portalChangePasswordService } from "./portal.auth.service";
import {
  requestPortalPasswordResetService,
  verifyPortalResetTokenService,
  resetPortalPasswordService,
} from "./portal.password-reset.service";
import { portalCookieConfig } from "./portal.cookie-config";
import { portalAuthMiddleware } from "./portal.auth.middleware";
import type { PortalEnv } from "./portal.auth.types";
import { checkPerKey, checkCompound, type RateLimitBucket } from "../../../lib/rate-limit";
import { formatZodError } from "../../../lib/zod-error-mapper";

// In-memory per-email rate limiter: 10 attempts per 15 minutes. The IP
// limiter (portalLoginRateLimiter) is the first line of defence; this is a
// secondary cap so a single account can't be brute-forced even when an
// attacker rotates source IPs. Counter is cleared on successful login so a
// user who finally types the right password doesn't carry burned attempts
// into their next session.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

const FORGOT_PER_EMAIL: RateLimitBucket = new Map();
const FORGOT_PER_IP: RateLimitBucket = new Map();

type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

function checkLoginRateLimit(email: string): RateLimitResult {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(email, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true };
  }
  entry.count++;
  if (entry.count <= RATE_LIMIT_MAX) return { ok: true };
  return { ok: false, retryAfter: Math.max(0, Math.ceil((entry.resetAt - now) / 1000)) };
}

function clearLoginRateLimit(email: string): void {
  loginAttempts.delete(email);
}

const portalAuthRoutes = new Hono<PortalEnv>();

portalAuthRoutes.post("/login", async (c) => {
  const parsed = portalLoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const limit = checkLoginRateLimit(email);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return c.json(
      {
        error: "Too many login attempts for this account. Please try again later.",
        retryAfter: limit.retryAfter,
      },
      429,
    );
  }

  const result = await portalLoginService(parsed.data);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 401);
  }

  // Successful login — clear the failed-attempt tally so this user starts
  // their next session fresh.
  clearLoginRateLimit(email);
  setCookie(c, "portal_session", result.data.token, portalCookieConfig);

  // Token also returned in body for the Authorization-header fallback. iOS
  // Safari drops the cross-site portal cookie and bounces mobile users to
  // /portal/login. portal.auth.middleware.ts:37-38 already accepts Bearer
  // tokens — the only missing piece was sending them.
  return c.json({ ok: true, token: result.data.token });
});

portalAuthRoutes.post("/logout", async (c) => {
  deleteCookie(c, "portal_session", {
    path: portalCookieConfig.path,
    ...(portalCookieConfig.domain && { domain: portalCookieConfig.domain }),
  });
  return c.json({ ok: true });
});

portalAuthRoutes.post("/change-password", portalAuthMiddleware, async (c) => {
  const session = c.get("session");
  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6, "New password must be at least 6 characters"),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }
  const result = await portalChangePasswordService(
    session.userId,
    parsed.data.currentPassword,
    parsed.data.newPassword,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 401 | 403 | 404);

  // Keep the user signed in on their new password: refresh the session cookie
  // and hand back the token for the Authorization-header fallback, exactly as
  // /login does. Without this the client has to sign out and re-authenticate,
  // which is where first-login tenants drop off (and where the password manager
  // re-fills the OLD temporary password and makes a successful change look
  // broken). result.token is null only if the account lost its partyId — the
  // caller's existing cookie is still valid, so nothing to do.
  if (result.token) {
    setCookie(c, "portal_session", result.token, portalCookieConfig);
  }
  return c.json({
    ok: true,
    message: "Password changed successfully.",
    ...(result.token ? { token: result.token } : {}),
  });
});

const forgotPasswordSchema = z.object({ email: z.string().email() });

portalAuthRoutes.post("/forgot-password", async (c) => {
  const parsed = forgotPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid email" }, 400);

  const email = parsed.data.email.trim().toLowerCase();
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

  const limit = checkCompound(
    () => checkPerKey(FORGOT_PER_EMAIL, email, 3, 15 * 60 * 1000),
    () => checkPerKey(FORGOT_PER_IP, ip, 20, 60 * 60 * 1000),
  );
  if (!limit.ok) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.rate_limited", surface: "portal", ip, retryAfter: limit.retryAfter }));
    c.header("Retry-After", String(limit.retryAfter));
    return c.json({ error: "Too many reset requests. Please try again later.", retryAfter: limit.retryAfter }, 429);
  }

  await requestPortalPasswordResetService(email);
  return c.json({ message: "If an account exists, a reset email has been sent." }, 200);
});

portalAuthRoutes.post("/verify-reset-token", async (c) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "expired_or_invalid" }, 401);

  const result = await verifyPortalResetTokenService(parsed.data.token);
  if (!result.ok) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.invalid_token", surface: "portal", ip, reason: "verify" }));
    return c.json({ error: "expired_or_invalid" }, 401);
  }
  return c.json({ ok: true, fullName: result.fullName });
});

portalAuthRoutes.post("/reset-password", async (c) => {
  const parsed = z.object({
    token: z.string().min(1),
    password: z.string().min(8, "Password must be at least 8 characters"),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const friendly = formatZodError(parsed.error, { domain: "auth" });
    return c.json({ error: friendly.message, fieldErrors: friendly.fieldErrors }, 400);
  }

  const result = await resetPortalPasswordService(parsed.data.token, parsed.data.password);
  if (!result.ok) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({ event: "password_reset.invalid_token", surface: "portal", ip, reason: "reset" }));
    return c.json({ error: result.error }, result.status as 401);
  }
  return c.json({ ok: true, message: "Password reset successful." });
});

export { portalAuthRoutes };
