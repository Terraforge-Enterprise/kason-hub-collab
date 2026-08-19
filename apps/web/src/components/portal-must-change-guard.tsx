import { Navigate, useLocation } from "react-router-dom";
import { usePortalSession } from "@/api/portal-auth";

/**
 * Wraps portal route subtrees. If the session has mustChangePassword=true,
 * redirects to /portal/change-password (unless already there).
 *
 * Logout is allowed (it's a button in the portal layout that calls the API
 * and clears the cookie — doesn't go through this guard).
 */
export function PortalMustChangeGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isLoading } = usePortalSession();
  const location = useLocation();

  if (isLoading) return null; // initial fetch — let the parent layout handle skeletons

  // If the call failed (e.g., 401), do nothing — the existing portal-layout login redirect handles it
  if (!session) return <>{children}</>;

  if (session.mustChangePassword && location.pathname !== "/portal/change-password") {
    return <Navigate to="/portal/change-password" replace />;
  }

  return <>{children}</>;
}
