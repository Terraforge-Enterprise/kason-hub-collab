import { lazy, Suspense } from "react";
import { Building2 } from "lucide-react";
import { usePortalProfile } from "@/components/portal-protected-route";
import { EmptyState } from "@/components/empty-state";

const TenantDashboard = lazy(() => import("./dashboard"));
const AgentHome = lazy(() => import("./agent-home"));
const OwnerDashboard = lazy(() => import("./owner-dashboard"));

export default function PortalDashboardDispatcher() {
  const { data } = usePortalProfile();
  const p = data?.data;
  const userType = p?.userType ?? "tenant";

  // Only evaluate once the profile has actually loaded (p defined) — during
  // the loading window p is undefined and both clauses are false, so this
  // never falsely hides a dashboard that just hasn't loaded yet.
  const nothingLinked =
    (p?.userType === "owner" && (p.propertyCount ?? 0) === 0) ||
    (p?.userType === "tenant" && !p.tenancyCode);

  if (nothingLinked) {
    return (
      <EmptyState
        icon={Building2}
        title="Nothing linked to your account yet"
        description="You don't have any properties or records connected yet. Please contact your administrator to get set up."
      />
    );
  }

  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" /></div>}>
      {userType === "agent"
        ? <AgentHome />
        : userType === "owner"
          ? <OwnerDashboard />
          : <TenantDashboard />}
    </Suspense>
  );
}
