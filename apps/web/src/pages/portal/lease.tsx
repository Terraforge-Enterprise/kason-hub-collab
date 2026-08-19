import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import type { PortalDashboardResponse } from "@kason/shared";

export default function PortalLeasePage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalDashboardResponse }>("/dashboard"),
  });

  if (isLoading) return <div className="animate-pulse text-sm text-[var(--text-secondary)]">Loading...</div>;

  const lease = data?.data?.lease;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Lease Details</h1>

      {!lease ? (
        <p className="text-sm text-[var(--text-secondary)]">No active lease found.</p>
      ) : (
        <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] p-6 space-y-4">
          <Row label="Tenancy Code" value={lease.tenancyCode} />
          <Row label="Property" value={lease.propertyName} />
          <Row label="Unit" value={lease.unitCode} />
          <Row label="Start Date" value={lease.startDate.slice(0, 10)} />
          <Row label="End Date" value={lease.endDate?.slice(0, 10) ?? "Open-ended"} />
          <Row label="Monthly Rent" value={`MYR ${lease.monthlyRentAmount.toFixed(2)}`} />
          <Row label="Status" value={lease.status} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-[var(--page-bg)] pb-2 last:border-0">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <span className="text-sm font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
