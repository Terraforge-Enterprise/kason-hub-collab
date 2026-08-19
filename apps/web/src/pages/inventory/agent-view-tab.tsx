// Admin /inventory "Agent View" tab — shows the inventory through the
// shared InventoryExplorer, linking to the admin detail page rather than
// the portal one. Mirrors the layout an agent would see in portal but
// stays inside the admin role envelope (apiFetch + admin routes).
//
// Wired to /listings/explorer (NOT /listings) so the data shape matches
// PORTAL_UNIT_SELECT — without that, the explorer's data-driven filter
// sections (City, Building, Furnishing, Floor preference, Facing,
// Vacant-since, Deposit months) hide themselves because the cardinality
// hook sees no values to populate them with.
//
// Test contract: agent-view-tab.test.tsx
//   - Cards link to `/inventory/units/:id` (NEVER `/portal/...`)
//   - apiFetch is called with `/listings/explorer`
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { InventoryExplorer } from "@/features/inventory-explorer/ui/inventory-explorer";
import type { InventoryListing } from "@/features/inventory-explorer/domain/types";

export function InventoryAgentViewTab() {
  const query = useQuery({
    queryKey: ["admin", "inventory", "agent-view"],
    queryFn: () => apiFetch<{ rows: InventoryListing[] }>("/listings/explorer"),
  });

  // /listings/explorer is the admin-scoped endpoint and returns EVERY unit
  // regardless of listing status (operators-see-all by design). The Agent
  // View tab is meant to mirror what an agent would see, so we apply the
  // same visibility gate that /portal-api/listings uses: only Units the
  // admin has marked as live (listingStatus="active"). Without this filter,
  // drafts leak into the preview and admins think drafts are agent-visible.
  const visibleUnits = (query.data?.rows ?? []).filter(
    (u) => u.listingStatus === "active",
  );

  return (
    <InventoryExplorer
      units={visibleUnits}
      isLoading={query.isLoading}
      isError={query.isError}
      getHref={(unit) => `/inventory/units/${unit.id}`}
      emptyMessage="There are no listings to show right now."
    />
  );
}
