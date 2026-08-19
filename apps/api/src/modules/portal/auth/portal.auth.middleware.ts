import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import { getDb } from "@kason/db";
import { verifySessionToken } from "../../../lib/auth";
import { createPortalSessionToken } from "./portal.auth.service";
import { portalCookieConfig } from "./portal.cookie-config";
import type { PortalEnv, PortalSessionPayload } from "./portal.auth.types";

const SLIDING_WINDOW_SECONDS = 1800; // 30 minutes
const BEARER_RECHECK_SECONDS = 300; // 5 minutes

// ── Bearer-auth status cache (5 min TTL) ──────────────────
const bearerStatusCache = new Map<string, { status: string; ts: number }>();

async function isBearerUserActive(userId: string): Promise<boolean> {
  const cached = bearerStatusCache.get(userId);
  if (cached && Date.now() - cached.ts < BEARER_RECHECK_SECONDS * 1000) {
    return cached.status === "active";
  }
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  const status = user?.status ?? "unknown";
  bearerStatusCache.set(userId, { status, ts: Date.now() });
  return status === "active";
}

export const portalAuthMiddleware = createMiddleware<PortalEnv>(async (c, next) => {
  // Try cookie first (web clients)
  let token = getCookie(c, "portal_session");
  let authMethod: "cookie" | "bearer" = "cookie";

  // Fall back to bearer token (mobile clients)
  if (!token) {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
      authMethod = "bearer";
    }
  }

  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const raw = await verifySessionToken(token, { issuer: "portal", audience: "portal" });
  if (!raw || !["tenant", "agent", "owner"].includes(raw.userType as string) || !raw.partyId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const session = raw as unknown as PortalSessionPayload;

  // Check absolute session ceiling
  if (typeof session.absoluteExp === "number" && Date.now() / 1000 > session.absoluteExp) {
    return c.json({ error: "Session expired" }, 401);
  }

  // Sliding session: only re-issue for cookie auth (mobile manages its own refresh)
  if (authMethod === "cookie") {
    const iat = session.iat ?? 0;
    const tokenAge = Date.now() / 1000 - iat;
    if (tokenAge > SLIDING_WINDOW_SECONDS) {
      const db = getDb();
      const user = await db.user.findUnique({
        where: { id: session.userId },
        select: { id: true, status: true },
      });
      if (!user || user.status !== "active") {
        return c.json({ error: "Account deactivated" }, 401);
      }

      const newToken = await createPortalSessionToken(
        session.userId, session.orgId, session.role,
        session.partyId, session.absoluteExp, session.userType,
      );
      setCookie(c, "portal_session", newToken, portalCookieConfig);
    }
  }

  // Bearer tokens: periodic DB status recheck (cached 5 min)
  if (authMethod === "bearer") {
    if (!(await isBearerUserActive(session.userId))) {
      return c.json({ error: "Account deactivated" }, 401);
    }
  }

  c.set("session", session);
  c.set("authMethod", authMethod);
  await next();
});
