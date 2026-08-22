import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "../lib/auth";
import { atLeast, type AdminRole } from "../lib/rbac";

// Re-export so downstream routes can keep importing `AdminRole` from this
// middleware without reaching across to `lib/rbac`. The canonical definition
// lives in `lib/rbac` — this is purely an alias.
export type { AdminRole };

const VALID_ROLES: ReadonlySet<string> = new Set<AdminRole>(["admin", "director", "manager", "editor"]);

export function requireRole(minRole: AdminRole) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (session.userType !== "operator") return c.json({ error: "Forbidden" }, 403);
    const role = session.role as AdminRole | undefined;
    if (!role || !VALID_ROLES.has(role)) return c.json({ error: "Forbidden" }, 403);
    if (!atLeast(role, minRole)) return c.json({ error: "Forbidden" }, 403);
    return next();
  });
}
