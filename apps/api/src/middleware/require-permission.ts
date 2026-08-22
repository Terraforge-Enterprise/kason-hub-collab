import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "../lib/auth";
import { getDb } from "@kason/db";
import { hasPermission, type Permission, type PermissionOverrides } from "../lib/permissions";

export function requirePermission(permission: Permission) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (session.userType !== "operator") return c.json({ error: "Forbidden" }, 403);
    const user = await getDb().user.findFirst({
      where: { id: session.userId, organizationId: session.orgId, status: "active" },
      select: { role: true, permissionOverrides: true },
    });
    if (!user || !hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides)) {
      return c.json({ error: "permission_forbidden", permission }, 403);
    }
    return next();
  });
}

export async function userHasPermission(session: SessionPayload, permission: Permission): Promise<boolean> {
  if (session.userType !== "operator") return false;
  const user = await getDb().user.findFirst({
    where: { id: session.userId, organizationId: session.orgId, status: "active" },
    select: { role: true, permissionOverrides: true },
  });
  return !!user && hasPermission(user.role, permission, user.permissionOverrides as PermissionOverrides);
}
