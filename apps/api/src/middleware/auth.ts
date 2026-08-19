import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { getDb } from "@kason/db";
import { verifySessionToken, type SessionPayload } from "../lib/auth";
import { authStatusCache } from "../lib/auth-status-cache";

async function isUserActive(userId: string): Promise<boolean> {
  const cached = authStatusCache.get(userId);
  if (cached) return cached.status === "active";
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  const status = user?.status ?? "unknown";
  authStatusCache.set(userId, status);
  return status === "active";
}

export const authMiddleware = createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
  // 1. Read token: cookie first, then Bearer header
  let token = getCookie(c, "admin_session");

  if (!token) {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    token = header.slice(7);
  }

  const session = await verifySessionToken(token, { issuer: "admin", audience: "admin" });

  if (!session) {
    return c.json({ error: "Invalid token" }, 401);
  }

  const adminTypes: string[] = ["operator"];
  if (session.userType && !adminTypes.includes(session.userType.toLowerCase())) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 2. DB status recheck (cached 60 s)
  if (!(await isUserActive(session.userId))) {
    return c.json({ error: "Account deactivated" }, 401);
  }

  c.set("session", session);
  await next();
});
