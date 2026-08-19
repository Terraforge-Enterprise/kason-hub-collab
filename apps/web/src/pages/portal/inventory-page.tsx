// apps/web/src/pages/portal/inventory-page.tsx
//
// Portal "Available Units" page. Thin wrapper around the shared
// InventoryExplorer orchestrator from features/inventory-explorer.
// Owns: the page header + the portal data fetch (portalApiFetch +
// /listings, returning { rows }). Everything else lives in the
// shared module so admin and portal can evolve in lockstep.
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { portalApiFetch } from "@/lib/portal-api";
import { InventoryExplorer, type InventoryListing } from "@/features/inventory-explorer";

export default function PortalInventoryPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["portal-listings"],
    queryFn: () => portalApiFetch<{ rows: InventoryListing[] }>("/listings"),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Building2 className="h-8 w-8 text-primary" />
          Available Units
        </h1>
        <p className="text-muted-foreground">Units you can currently market to prospective tenants</p>
      </div>

      <InventoryExplorer
        units={data?.rows ?? []}
        isLoading={isLoading}
        isError={isError}
        getHref={(unit) => `/portal/inventory/${unit.id}`}
        emptyMessage="There are no units available to you right now."
        errorMessage="Failed to load available units. Please refresh the page."
      />
    </div>
  );
}
