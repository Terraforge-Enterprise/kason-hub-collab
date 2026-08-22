import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { LandlordTenancyTable } from "./landlord-tenancies-table";
import type { LandlordTenancyListItem } from "./landlord-tenancies-table";

export default function LandlordTenanciesPage() {
  const tenancies = useQuery({
    queryKey: ["tenancy", "landlord-tenancies"],
    queryFn: async () => {
      // Managers/admins repair legacy agreement bridges automatically. A
      // read-only user may receive 403 here but must still be able to read the
      // existing register.
      try {
        await apiFetch("/tenancy/landlord-tenancies/sync-managed", { method: "POST" });
      } catch {
        // Continue with the read request below.
      }
      return apiFetch<{ data: LandlordTenancyListItem[] }>("/tenancy/landlord-tenancies");
    },
  });

  const isLoading = tenancies.isLoading;
  const hasError = tenancies.isError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load landlord tenancy data. Please refresh.
      </p>
    );
  }

  const tenancyList = tenancies.data!.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Property Management Agreements"
        description="Create, edit, preview and download the agreements between KAEN and each property owner."
        metrics={[
          {
            label: "Agreement records",
            value: String(tenancyList.length),
            hint: "Owners appointed KAEN to manage",
          },
          {
            label: "Active",
            value: String(tenancyList.filter((t) => t.status === "active").length),
            hint: "Currently billing or operating",
          },
          {
            label: "Paused",
            value: String(tenancyList.filter((t) => t.status === "paused").length),
            hint: "Temporarily inactive",
          },
        ]}
      />
      <Surface
        title="Management agreement register"
        description="Create, edit, preview or download the management agreement for each managed owner and property."
      >
        <LandlordTenancyTable tenancies={tenancyList} />
      </Surface>
    </div>
  );
}
