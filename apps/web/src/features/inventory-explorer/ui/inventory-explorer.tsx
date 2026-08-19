// apps/web/src/features/inventory-explorer/ui/inventory-explorer.tsx
//
// Lift-and-shift of the body of pages/portal/inventory-page.tsx — preserves
// PAGE_SIZE, default group, default view, mobile sheet, "Load N more · X left"
// copy, occupancy stats strip, and the activeFilterCount formula. The only
// behavioural addition is the optional emptyMessage prop so admin can override
// the portal-specific copy.
//
// The orchestrator is render-only: data fetching stays in the consuming page.
// That keeps the role envelopes disjoint (portal uses portalApiFetch, admin
// uses apiFetch) and makes this module structurally unable to leak across.

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Building2 } from "lucide-react";
import { InventoryFilters, countActiveFilters } from "./inventory-filters";
import { InventoryToolbar } from "./inventory-toolbar";
import { InventoryActiveChips } from "./inventory-active-chips";
import { InventoryStatsStrip } from "./inventory-stats";
import { InventoryGroup } from "./inventory-group";
import { UnitCard } from "./unit-card";
import { useInventoryUrlState } from "../hooks/use-inventory-filters";
import { filterUnits } from "../logic/filter-units";
import { sortUnits } from "../logic/sort-units";
import { groupUnitsByBuilding } from "../logic/group-units";
import { deriveStats } from "../logic/derive-stats";
import type { InventoryListing } from "../domain/types";

const PAGE_SIZE = 24;

export type InventoryExplorerProps = {
  units: InventoryListing[];
  isLoading: boolean;
  isError: boolean;
  /** Caller-supplied router path. Card renders <Link to={getHref(unit)}>. */
  getHref: (unit: InventoryListing) => string;
  /** Override the default empty-state copy when no units are available. */
  emptyMessage?: string;
  /** Override the default error-state copy. */
  errorMessage?: string;
};

export function InventoryExplorer({
  units,
  isLoading,
  isError,
  getHref,
  emptyMessage,
  errorMessage,
}: InventoryExplorerProps) {
  const url = useInventoryUrlState();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const allUnits = units;

  // Stable per-mount "now" — the page lives long enough that recomputing
  // on every render would invalidate every downstream useMemo, but short
  // enough that "stale at midnight on a multi-day idle tab" is acceptable.
  // The agent will reload the portal far more often than once a day.
  const today = useMemo(() => new Date(), []);

  const filtered = useMemo(
    () => filterUnits(allUnits, url.filters, today),
    [allUnits, url.filters, today],
  );
  const sorted = useMemo(() => sortUnits(filtered, url.sort), [filtered, url.sort]);
  const stats = useMemo(() => deriveStats(filtered), [filtered]);

  const activeFilterCount = useMemo(() => countActiveFilters(url.filters), [url.filters]);
  const anyFilterActive = activeFilterCount > 0;

  const visible = sorted.slice(0, url.take);
  const remaining = Math.max(0, sorted.length - visible.length);

  const buckets = useMemo(
    () => url.group === "building" ? groupUnitsByBuilding(visible) : [],
    [url.group, visible],
  );

  return (
    <div className="space-y-4">
      <InventoryStatsStrip stats={stats} total={allUnits.length} />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* Desktop filter sidebar */}
        <div className="hidden lg:block">
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardContent className="p-4">
              <InventoryFilters value={url.filters} onChange={url.setFilters} units={allUnits} />
            </CardContent>
          </Card>
        </div>

        {/* Main column */}
        <div className="space-y-4">
          <InventoryToolbar
            q={url.filters.q}
            onQChange={(q) => url.setFilters({ ...url.filters, q })}
            group={url.group}
            onGroupChange={url.setGroup}
            view={url.view}
            onViewChange={url.setView}
            sort={url.sort}
            onSortChange={url.setSort}
            onOpenMobileFilters={() => setMobileFiltersOpen(true)}
            activeFilterCount={activeFilterCount}
          />

          <InventoryActiveChips value={url.filters} onChange={url.setFilters} units={allUnits} />

          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-64 rounded-xl bg-muted" />)}
            </div>
          ) : isError ? (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardContent className="p-8 text-center text-sm text-rose-500">
                {errorMessage ?? "Failed to load inventory. Please refresh the page."}
              </CardContent>
            </Card>
          ) : visible.length === 0 ? (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardContent className="p-8 text-center">
                <Building2 className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">
                  {anyFilterActive
                    ? "No units match your filters."
                    : emptyMessage ?? "There are no units to show right now."}
                </p>
              </CardContent>
            </Card>
          ) : url.group === "building" ? (
            <div className="space-y-6">
              {buckets.map((b, i) => (
                <InventoryGroup
                  key={b.buildingName}
                  bucket={b}
                  defaultExpanded={i < 3}
                  view={url.view}
                  getHref={getHref}
                  today={today}
                />
              ))}
            </div>
          ) : url.view === "list" ? (
            <div className="space-y-2">
              {visible.map((u) => <UnitCard key={u.id} unit={u} to={getHref(u)} view="list" today={today} />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visible.map((u) => <UnitCard key={u.id} unit={u} to={getHref(u)} view="grid" today={today} />)}
            </div>
          )}

          {remaining > 0 && (
            <div className="flex justify-center pt-2">
              <Button type="button" variant="outline" onClick={() => url.setTake(url.take + PAGE_SIZE)}>
                Load {Math.min(PAGE_SIZE, remaining)} more · {remaining} left
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile filter sheet */}
      <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <SheetContent size="md">
          <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
          <div className="p-4">
            <InventoryFilters value={url.filters} onChange={url.setFilters} units={allUnits} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
