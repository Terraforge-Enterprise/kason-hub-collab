import { Navigate } from "react-router-dom";
import { usePortalProfile } from "@/components/portal-protected-route";

export function RoleRoute({ allowed, children }: { allowed: string[]; children: React.ReactNode }) {
  const { data } = usePortalProfile();
  const userType = data?.data?.userType;
  if (userType && !allowed.includes(userType)) {
    return <Navigate to="/portal/dashboard" replace />;
  }
  return <>{children}</>;
}
