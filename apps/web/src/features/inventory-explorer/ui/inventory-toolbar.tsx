import { Search, LayoutGrid, List as ListIcon, Layers } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { GroupKey, SortKey, ViewMode } from "../domain/types";

const SORT_LABELS: Record<SortKey, string> = {
  ready: "Ready now first",
  "price-asc": "Price: low → high",
  "price-desc": "Price: high → low",
  "sqft-desc": "Largest first",
  newest: "Newest listed",
  "beds-desc": "Most bedrooms",
};

type Props = {
  q: string;
  onQChange: (q: string) => void;
  group: GroupKey;
  onGroupChange: (g: GroupKey) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  onOpenMobileFilters: () => void;
  activeFilterCount: number;
};

export function InventoryToolbar({
  q, onQChange, group, onGroupChange, view, onViewChange, sort, onSortChange,
  onOpenMobileFilters, activeFilterCount,
}: Props) {
  return (
    <div className="sticky top-0 z-10 -mx-2 px-2 py-3 bg-background/80 backdrop-blur-xl border-b border-border/50 flex flex-wrap items-center gap-2">
      <Button
        type="button" variant="outline" size="sm"
        className="lg:hidden"
        onClick={onOpenMobileFilters}
      >
        Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
      </Button>
      <label className="flex flex-1 items-center gap-2 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm focus-within:border-[var(--primary)] focus-within:ring-2 focus-within:ring-[var(--ring)] min-w-[180px]">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder="Search by code, condo, city…"
          className="flex-1 bg-transparent outline-none placeholder:text-[var(--text-muted)]"
          aria-label="Search inventory"
        />
      </label>

      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition">
          <Layers className="h-4 w-4" />
          {group === "building" ? "Group: Building" : "Group: None"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onGroupChange("building")}>By building</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onGroupChange("none")}>None (flat)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="inline-flex rounded-md border border-border/60 overflow-hidden">
        <button
          type="button"
          onClick={() => onViewChange("grid")}
          aria-label="Grid view"
          aria-pressed={view === "grid"}
          className={`px-2.5 py-1.5 ${view === "grid" ? "bg-[var(--gold)]/15 text-foreground" : "text-muted-foreground hover:bg-muted/40"}`}
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewChange("list")}
          aria-label="List view"
          aria-pressed={view === "list"}
          className={`px-2.5 py-1.5 ${view === "list" ? "bg-[var(--gold)]/15 text-foreground" : "text-muted-foreground hover:bg-muted/40"}`}
        >
          <ListIcon className="h-4 w-4" />
        </button>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex items-center rounded-md border border-border/60 bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition">
          Sort: {SORT_LABELS[sort]}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <DropdownMenuItem key={k} onClick={() => onSortChange(k)}>{SORT_LABELS[k]}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
