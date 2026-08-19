import { Navigate, useLocation } from "react-router-dom";
import { useAdminSession } from "@/api/admin-auth";

/**
 * Wraps admin route subtrees. If the session has mustChangePassword=true,
 * redirects to /change-password (unless already there).
 *
 * Logout is allowed (it's a button in the admin layout that calls the API
 * and clears the cookie — doesn't go through this guard).
 */
export function AdminMustChangeGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isLoading } = useAdminSession();
  const location = useLocation();

  if (isLoading) return null; // initial fetch — let the parent layout handle skeletons

  // If the call failed (e.g., 401), do nothing — the existing admin login redirect handles it
  if (!session) return <>{children}</>;

  if (session.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}
