import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { LandlordTenancyTable } from "./landlord-tenancies-table";
import { LandlordTenancyForms } from "./landlord-tenancies-forms";
import type { LandlordTenancyListItem } from "./landlord-tenancies-table";

type PropertyListItem = { id: string; name: string; propertyCode: string };
type OwnerListItem = { id: string; displayName: string };

export default function LandlordTenanciesPage() {
  const tenancies = useQuery({
    queryKey: ["tenancy", "landlord-tenancies"],
    queryFn: () => apiFetch<{ data: LandlordTenancyListItem[] }>("/tenancy/landlord-tenancies"),
  });

  const properties = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: PropertyListItem[] }>("/inventory/properties"),
  });

  const owners = useQuery({
    queryKey: ["parties", "owners"],
    queryFn: () => apiFetch<{ data: OwnerListItem[] }>("/parties/owners"),
  });

  const isLoading = tenancies.isLoading || properties.isLoading || owners.isLoading;
  const hasError = tenancies.isError || properties.isError || owners.isError;

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
  const propertyList = properties.data!.data;
  const ownerList = owners.data!.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Landlord tenancy linkages"
        description="Connect owners to properties with rent, deposits, and current agreement status visible at a glance."
        metrics={[
          {
            label: "Linkages",
            value: String(tenancyList.length),
            hint: "Total owner-property relationships",
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
          {
            label: "Owners in pool",
            value: String(ownerList.length),
            hint: `${propertyList.length} properties available`,
          },
        ]}
      />
      <Surface
        title="Relationship register"
        description="Current owner-property agreements across the portfolio."
      >
        <LandlordTenancyTable tenancies={tenancyList} />
      </Surface>
      <LandlordTenancyForms
        properties={propertyList.map((p) => ({
          id: p.id,
          name: p.name,
          propertyCode: p.propertyCode,
        }))}
        owners={ownerList.map((o) => ({
          id: o.id,
          displayName: o.displayName,
        }))}
        tenancies={tenancyList.map((lt) => ({
          id: lt.id,
          propertyName: lt.propertyName,
          landlordName: lt.landlordName,
        }))}
      />
    </div>
  );
}
