import { Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PortalApiError, portalApiFetch } from "@/lib/portal-api";

type PortalProfile = {
  fullName: string;
  email: string;
  phone: string;
  partyType: string;
  userType: string;
  unitCode?: string | null;
  propertyName?: string | null;
  tenancyCode?: string | null;
  propertyCount?: number;
  agentLevel?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  photoKey?: string | null;
  photoUrl?: string | null;
};

export function usePortalProfile() {
  return useQuery({
    queryKey: ["portal-profile"],
    queryFn: () => portalApiFetch<{ data: PortalProfile }>("/profile", { redirectOnUnauthorized: false }),
    staleTime: 60_000,
    retry: false,
  });
}

export function PortalProtectedRoute({ children }: { children: React.ReactNode }) {
  const { data, isLoading, error } = usePortalProfile();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
      </div>
    );
  }

  if (error instanceof PortalApiError && error.status === 401) {
    return <Navigate to="/portal/login" state={{ from: location }} replace />;
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Portal temporarily unavailable</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          We couldn&apos;t verify your portal session right now. Please refresh and try again.
        </p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return <>{children}</>;
}
