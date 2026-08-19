import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { usePortalProfile } from "@/components/portal-protected-route";
import { formatRM, formatDateMY, getStatusTone } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import type { PortalDashboardResponse } from "@kason/shared";
import { FileText, Users, Building2, Mail } from "lucide-react";

// Task 4 (tenant-portal-redesign, Appendix A §2 My Tenancy) — replaces the old
// six-field <PortalLeasePage> (lease.tsx, still routed at /portal/lease until
// another task rewires the router) with a Tenancy Summary / Occupants /
// Property Management layout on the design-standard glass-card shell.
//
// OUT OF SCOPE (no API field): deposit held, multi-occupant list, rent-due-day,
// renewal. These are NOT in PortalDashboardResponse.lease — render only the
// fields the API actually returns; never fabricate a plausible-looking value
// for the rest (frontend SKILL §16 — a fabricated fallback masks a real
// contract regression the same way a silently-dropped field would).

export default function PortalMyTenancyPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalDashboardResponse }>("/dashboard"),
  });
  // Fallback name source only — d.tenant.displayName (below) is a required
  // field on the schema and is the primary source.
  const { data: profile } = usePortalProfile();

  if (isLoading) return <MyTenancySkeleton />;

  const d = data?.data;
  if (!d) return null;

  const lease = d.lease;
  const tenantName = d.tenant.displayName || profile?.data?.fullName || "Tenant";

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Header */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <FileText className="h-8 w-8 text-primary" />
          My Tenancy
        </h1>
        <p className="text-muted-foreground mt-1">Details about your rental and agreement.</p>
      </div>

      {!lease ? (
        <EmptyState
          icon={FileText}
          title="No active tenancy"
          description="You have no active lease on record."
        />
      ) : (
        <>
          {/* Tenancy Summary */}
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-bold flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                Tenancy Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SummaryRow label="Tenancy code" value={lease.tenancyCode} />
              <SummaryRow label="Property" value={lease.propertyName} />
              <SummaryRow label="Unit" value={lease.unitCode} />
              <SummaryRow
                label="Lease period"
                value={`${formatDateMY(lease.startDate)} – ${lease.endDate ? formatDateMY(lease.endDate) : "Open-ended"}`}
              />
              <SummaryRow label="Monthly rent" value={formatRM(lease.monthlyRentAmount)} />
              <SummaryRow
                label="Status"
                value={<Badge variant={badgeTone(lease.status)}>{lease.status}</Badge>}
                last
              />
            </CardContent>
          </Card>

          {/* Occupants + Property Management */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl font-bold flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  Occupants
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm">
                  <span className="text-sm text-foreground">{tenantName}</span>
                  <Badge variant="gold">Main tenant</Badge>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl font-bold flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  Property Management
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-semibold text-foreground">KAEN Properties</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Managing agent for your property.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/portal/documents" className={cn(buttonVariants({ variant: "gold" }), "gap-2")}>
              <FileText className="h-4 w-4" />
              View tenancy agreement
            </Link>
            {/* Static — no support email/phone exists anywhere in the app to
                wire this to (apps/api's only configured address is a
                no-reply sender), so this stays inert rather than fabricate a
                contact channel that doesn't exist. */}
            <button
              type="button"
              disabled
              title="Contact details coming soon"
              className={cn(buttonVariants({ variant: "outline" }), "gap-2 disabled:opacity-50")}
            >
              <Mail className="h-4 w-4" />
              Contact management
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between py-2.5", !last && "border-b border-border/50")}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

/** Map getStatusTone → Badge variant (Badge has no "slate" variant). */
function badgeTone(status?: string | null) {
  const t = getStatusTone(status);
  return t === "slate" ? ("secondary" as const) : t;
}

function MyTenancySkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-56 bg-muted rounded" />
      <div className="h-64 bg-muted rounded-xl" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-40 bg-muted rounded-xl" />
        <div className="h-40 bg-muted rounded-xl" />
      </div>
      <div className="h-10 w-72 bg-muted rounded" />
    </div>
  );
}
