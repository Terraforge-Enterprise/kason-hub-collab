import { useAuth } from "@/lib/auth";

/**
 * Admin roles recognised by the UI. Mirrors apps/api/src/lib/rbac.ts.
 * editor < manager < admin — higher rank includes every lower-rank capability.
 */
export type AdminRole = "admin" | "manager" | "editor";

const ROLE_RANK: Record<AdminRole, number> = { editor: 1, manager: 2, admin: 3 };

/**
 * Hide children unless the current session meets `min` (admin role rank).
 * Non-operator users (portal tenants/owners/agents) and users missing a
 * recognised admin role are treated as below every rank and see `fallback`.
 *
 * Use this to strip destructive/approval buttons (e.g. approve claim,
 * deactivate agent) from the UI for Normal Admins — purely a visual
 * optimisation; the server still enforces the same gate.
 */
export function RoleGate({
  min,
  children,
  fallback = null,
}: {
  min: AdminRole;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { user } = useAuth();
  const role = user?.role as AdminRole | undefined;
  if (!role || !(role in ROLE_RANK) || ROLE_RANK[role] < ROLE_RANK[min]) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
