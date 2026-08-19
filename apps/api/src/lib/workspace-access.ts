import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "./auth";
import { atLeast, type AdminRole } from "./rbac";

export type Workspace = "operations" | "accounting";

// Non-hierarchical capability map, keyed off the raw session.role string
// (SessionPayload.role is a plain string). Every known role literal across the
// drifted ladders (roles.ts operator/viewer; rbac.ts editor) is enumerated;
// an unmapped role resolves to the EMPTY set (default-deny). `accountant` is
// deliberately NOT a rank — see apps/api/src/lib/rbac.ts.
const WORKSPACE_ACCESS: Record<string, ReadonlySet<Workspace>> = {
  admin: new Set<Workspace>(["operations", "accounting"]),
  manager: new Set<Workspace>(["operations", "accounting"]),
  editor: new Set<Workspace>(["operations"]),
  operator: new Set<Workspace>(["operations"]),
  viewer: new Set<Workspace>(["operations"]),
  accountant: new Set<Workspace>(["accounting"]),
};

const EMPTY: ReadonlySet<Workspace> = new Set<Workspace>();

export function workspacesFor(role: string | undefined): ReadonlySet<Workspace> {
  return WORKSPACE_ACCESS[role ?? ""] ?? EMPTY;
}

export function hasWorkspace(role: string | undefined, ws: Workspace): boolean {
  return workspacesFor(role).has(ws);
}

export function requireWorkspace(ws: Workspace) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (!hasWorkspace(session.role, ws)) return c.json({ error: "workspace_forbidden" }, 403);
    return next();
  });
}

/**
 * Admit a session that EITHER holds `ws` in its (non-hierarchical) workspace set
 * OR meets the rank floor `minRole`. Lets an accountant reach a money route via
 * the accounting workspace WITHOUT being added to RANK, while existing
 * rank-holders (editor/manager/admin) keep their access unchanged.
 */
export function requireWorkspaceOrRank(ws: Workspace, minRole: AdminRole) {
  return createMiddleware<{ Variables: { session: SessionPayload } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    if (hasWorkspace(session.role, ws)) return next();
    if (atLeast(session.role as AdminRole, minRole)) return next();
    return c.json({ error: "workspace_forbidden" }, 403);
  });
}
