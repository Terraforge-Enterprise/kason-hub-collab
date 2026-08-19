/**
 * Unit Analytics page (Spec 2 §4.4) — admin read-only analytics dashboard.
 *
 * Flag-gated: route + nav only exist when ENABLE_PHASE2_UNIT_ANALYTICS is on
 * (see router.tsx / navigation.ts). API routes 404 when the flag is dark.
 *
 * Shows:
 *   – Hero: 4 GlowCards (Open backlog / Aging / Avg resolve time / Repeat-issue units)
 *   – Property filter (in PageHeader actions area)
 *   – Window selector (30d / 90d / 12mo / all, default 90d) in Rankings Surface actions
 *   – Filter row: Category select + Status select + Search input (all client-side)
 *   – Ranked unit table (sortable by open/windowTotal/total; worst-first default)
 *     · Columns: # · Unit · Property · Open (sortable) · In window (sortable) · All-time (sortable) · Top problems
 *     · Top problems: byCategory.slice(0,3) pills "<canonical> <count>"; recurring = amber; non-recurring = muted
 *   – Data-quality nudge when unmapped.count > 0
 *   – Loading skeleton + empty state
 *
 * Charts (CategoryBars + CreatedVsResolvedChart) removed per plan §Global Constraints.
 *
 * Mirrors: tenant-tracker-page.tsx (PageHeader + Surface + property filter).
 * (It also mirrored owner-statements-page.tsx's list + filter pattern; that page
 *  was retired when the Owner Ledger took over issuing the management fee.)
 */

import { useState, useMemo } from "react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  ChevronDown,
  ChevronUp,
  Clock,
  ChevronsUpDown,
  RefreshCcw,
  RepeatIcon,
  Search,
  Timer,
} from "lucide-react";
import type { AnalyticsWindow, UnitAnalyticsRow } from "@kason/shared";
import UnitDetailDrawer from "./unit-analytics/unit-detail-drawer";
import { PageHeader, Surface, TableWrap, DataTable, TableHead, HeadCell, BodyCell, StatusPill } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/ui/segmented";
import type { SegmentedOption } from "@/components/ui/segmented";
import {
  useUnitAnalytics,
  useCategoryLens,
} from "@/api/analytics";
import { useTrackerSummary } from "@/api/tenant-tracker";

// ── Window options ─────────────────────────────────────────────────────────────

const WINDOW_OPTIONS: SegmentedOption<AnalyticsWindow>[] = [
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "12mo", label: "12mo" },
  { value: "all", label: "All" },
];

// ── Sort types ────────────────────────────────────────────────────────────────

type SortKey = "open" | "windowTotal" | "total";
type SortDir = "desc" | "asc";

// ── Skeleton ──────────────────────────────────────────────────────────────────

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-64 bg-muted rounded" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="h-48 bg-muted rounded-xl" />
    </div>
  );
}

// ── Property filter select ────────────────────────────────────────────────────

function PropertySelect({
  value,
  onChange,
  properties,
}: {
  value: string;
  onChange: (v: string) => void;
  properties: Array<{ propertyId: string; name: string }>;
}) {
  return (
    <div className="flex items-center gap-2">
      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="property-selector"
        className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
      >
        <option value="">All properties</option>
        {properties.map((p) => (
          <option key={p.propertyId} value={p.propertyId}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Sort indicator icon ───────────────────────────────────────────────────────

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="ml-1 h-3 w-3 text-muted-foreground/50" />;
  return dir === "desc"
    ? <ChevronDown className="ml-1 h-3 w-3 text-foreground" />
    : <ChevronUp className="ml-1 h-3 w-3 text-foreground" />;
}

// ── Top-problems pills ────────────────────────────────────────────────────────

function TopProblems({ row }: { row: UnitAnalyticsRow }) {
  const topCats = row.byCategory.slice(0, 3);
  if (topCats.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {topCats.map((cat) => (
        <StatusPill key={cat.canonical} tone={cat.recurring ? "amber" : "slate"}>
          {cat.canonical} {cat.count}
        </StatusPill>
      ))}
    </div>
  );
}

// ── Unit table — sortable + filterable ────────────────────────────────────────

interface UnitRankTableProps {
  rows: UnitAnalyticsRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onRowClick: (row: UnitAnalyticsRow) => void;
}

function UnitRankTable({ rows, sortKey, sortDir, onSort, onRowClick }: UnitRankTableProps) {
  return (
    <>
      {/* ≥lg: standard table */}
      <div className="hidden lg:block">
        <TableWrap>
          <DataTable>
            <TableHead>
              <tr>
                <HeadCell>#</HeadCell>
                <HeadCell>Unit</HeadCell>
                <HeadCell>Property</HeadCell>
                <HeadCell className="text-right">
                  <button
                    type="button"
                    onClick={() => onSort("open")}
                    className="ml-auto flex items-center text-right outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    aria-label={`Sort by Open${sortKey === "open" ? (sortDir === "desc" ? ", descending" : ", ascending") : ""}`}
                  >
                    Open
                    <SortIndicator active={sortKey === "open"} dir={sortDir} />
                  </button>
                </HeadCell>
                <HeadCell className="text-right">
                  <button
                    type="button"
                    onClick={() => onSort("windowTotal")}
                    className="ml-auto flex items-center text-right outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    aria-label={`Sort by In window${sortKey === "windowTotal" ? (sortDir === "desc" ? ", descending" : ", ascending") : ""}`}
                  >
                    In window
                    <SortIndicator active={sortKey === "windowTotal"} dir={sortDir} />
                  </button>
                </HeadCell>
                <HeadCell className="text-right">
                  <button
                    type="button"
                    onClick={() => onSort("total")}
                    className="ml-auto flex items-center text-right outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    aria-label={`Sort by All-time${sortKey === "total" ? (sortDir === "desc" ? ", descending" : ", ascending") : ""}`}
                  >
                    All-time
                    <SortIndicator active={sortKey === "total"} dir={sortDir} />
                  </button>
                </HeadCell>
                <HeadCell>Top problems</HeadCell>
              </tr>
            </TableHead>
            <tbody>
              {rows.map((r, i) => (
                // Clickable row — uses <tr> directly (Row component doesn't spread extra props).
                // Sort-header buttons live in <thead> so their clicks never reach this handler.
                <tr
                  key={r.unitId}
                  onClick={() => onRowClick(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(r);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`View details for unit ${r.unitCode}`}
                  className="border-b border-[var(--border)] cursor-pointer transition hover:bg-[var(--page-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <BodyCell className="text-muted-foreground tabular-nums w-8">{i + 1}</BodyCell>
                  <BodyCell>
                    <span className="font-medium">{r.unitCode}</span>
                  </BodyCell>
                  <BodyCell className="text-muted-foreground">{r.propertyName}</BodyCell>
                  <BodyCell className="text-right tabular-nums">
                    {r.open > 0 ? (
                      <span className="text-rose-600 font-semibold">{r.open}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </BodyCell>
                  <BodyCell className="text-right tabular-nums font-semibold">
                    {r.windowTotal}
                  </BodyCell>
                  <BodyCell className="text-right tabular-nums text-muted-foreground">
                    {r.total}
                  </BodyCell>
                  <BodyCell>
                    <TopProblems row={r} />
                  </BodyCell>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </TableWrap>
      </div>

      {/* <lg: stacked cards (no horizontal scroll required) */}
      <div className="lg:hidden space-y-3" data-testid="unit-cards-mobile">
        {rows.map((r, i) => (
          <div
            key={r.unitId}
            role="button"
            tabIndex={0}
            aria-label={`View details for unit ${r.unitCode}`}
            onClick={() => onRowClick(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRowClick(r);
              }
            }}
            className="rounded-lg border border-border/50 bg-background/40 px-4 py-3 space-y-1.5 cursor-pointer transition-all hover:bg-background/60 hover:border-border/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">
                <span className="text-muted-foreground text-xs mr-1">#{i + 1}</span>
                {r.unitCode}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{r.propertyName}</p>
            <div className="flex items-center gap-4 text-sm">
              <span>
                <span className="text-muted-foreground text-xs">Open </span>
                <span
                  className={
                    r.open > 0
                      ? "font-semibold text-rose-600 tabular-nums"
                      : "text-muted-foreground tabular-nums"
                  }
                >
                  {r.open}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground text-xs">In window </span>
                <span className="font-semibold tabular-nums">{r.windowTotal}</span>
              </span>
              <span>
                <span className="text-muted-foreground text-xs">All-time </span>
                <span className="tabular-nums text-muted-foreground">{r.total}</span>
              </span>
            </div>
            {r.byCategory.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {r.byCategory.slice(0, 3).map((cat) => (
                  <StatusPill key={cat.canonical} tone={cat.recurring ? "amber" : "slate"}>
                    {cat.canonical} {cat.count}
                  </StatusPill>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UnitAnalyticsPage() {
  const [window, setWindow] = useState<AnalyticsWindow>("90d");
  const [propertyId, setPropertyId] = useState("");

  // Sort state — default: open desc (worst-first)
  const [sortKey, setSortKey] = useState<SortKey>("open");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "open">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Drill-down drawer state (Task 3)
  const [selectedUnit, setSelectedUnit] = useState<UnitAnalyticsRow | null>(null);

  const filters = propertyId ? { window, propertyId } : { window };

  const analytics = useUnitAnalytics(filters);
  // useCategoryLens kept for the window-level category-lens hook (used by window selector tests)
  const categories = useCategoryLens(filters);

  // Properties come from TrackerSummary — same source as Tenant Tracker.
  const trackerSummary = useTrackerSummary();
  const properties = trackerSummary.data?.properties ?? [];

  const rows = analytics.data?.data.rows ?? [];
  const unmapped = analytics.data?.data.unmapped;
  const analyticSummary = analytics.data?.data.summary;

  // ── Derived: distinct category options from all rows' byCategory ──────────
  // NOTE: must be before any early return (Rules of Hooks)
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      for (const cat of r.byCategory) {
        seen.add(cat.canonical);
      }
    }
    return Array.from(seen).sort();
  }, [rows]);

  // ── Derived: filter → sort ────────────────────────────────────────────────
  // NOTE: must be before any early return (Rules of Hooks)
  const displayedRows = useMemo(() => {
    let result = rows;

    // 1. category filter
    if (categoryFilter) {
      result = result.filter((r) =>
        r.byCategory.some((c) => c.canonical === categoryFilter),
      );
    }

    // 2. status filter
    if (statusFilter === "open") {
      result = result.filter((r) => r.open > 0);
    }

    // 3. unitCode search (case-insensitive substring)
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((r) => r.unitCode.toLowerCase().includes(q));
    }

    // 4. sort — when a category filter is active, sort by that category's count desc
    const sorted = [...result].sort((a, b) => {
      if (categoryFilter) {
        const aCount = a.byCategory.find((c) => c.canonical === categoryFilter)?.count ?? 0;
        const bCount = b.byCategory.find((c) => c.canonical === categoryFilter)?.count ?? 0;
        return bCount - aCount;
      }
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      return sortDir === "desc" ? bVal - aVal : aVal - bVal;
    });

    return sorted;
  }, [rows, categoryFilter, statusFilter, searchQuery, sortKey, sortDir]);

  // ── Loading / error guard (after all hooks) ───────────────────────────────
  // categories.isLoading intentionally excluded — category options derive from rows;
  // a slow/failed category-lens should not blank the whole page.
  const isLoading = analytics.isLoading;
  const isError = analytics.isError || categories.isError;

  if (isLoading) {
    return <AnalyticsSkeleton />;
  }

  // ── Sort handler — toggle dir when same key, reset to desc on new key ──────
  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  // Aggregate metrics for PageHeader
  const openTickets = rows.reduce((n, r) => n + r.open, 0);
  const recurringUnits = rows.filter((r) => r.recurringCategories.length > 0).length;

  // Format summary values defensively
  const mttrDisplay = analyticSummary?.mttrDays != null
    ? `${analyticSummary.mttrDays.toFixed(1)} days`
    : "—";
  const agingDisplay = analyticSummary?.oldestOpenDays != null
    ? `${Math.round(analyticSummary.oldestOpenDays)} days`
    : "—";
  const openOver30 = analyticSummary?.openOver30 ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Unit Analytics"
        description="Ticket volume and recurring-problem analysis per unit — worst-first."
        icon={BarChart3}
        actions={
          <PropertySelect
            value={propertyId}
            onChange={setPropertyId}
            properties={properties}
          />
        }
        metrics={[
          {
            label: "Open backlog",
            value: String(openTickets),
            hint: `${rows.length} units tracked`,
            icon: AlertTriangle,
            glowColor: "orange",
          },
          {
            label: "Aging",
            value: agingDisplay,
            hint: analyticSummary?.oldestOpenDays != null ? `${openOver30} open >30d` : undefined,
            icon: Timer,
            glowColor: "red",
          },
          {
            label: "Avg resolve time",
            value: mttrDisplay,
            hint: "MTTR · window",
            icon: Clock,
            glowColor: "green",
          },
          {
            label: "Repeat-issue units",
            value: String(recurringUnits),
            hint: "≥3 tickets, same category",
            icon: RepeatIcon,
            glowColor: "purple",
          },
        ]}
      />

      {/* Error state */}
      {isError && (
        <Callout variant="danger" title="Failed to load analytics">
          One or more data sources returned an error.{" "}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => {
              void analytics.refetch();
              void categories.refetch();
            }}
          >
            <RefreshCcw className="mr-1 h-3 w-3" />
            Retry
          </Button>
        </Callout>
      )}

      {/* Data-quality nudge — only when unmapped.count > 0 */}
      {unmapped && unmapped.count > 0 && (
        <Callout variant="warning" title="Data quality">
          {unmapped.count} ticket{unmapped.count === 1 ? "" : "s"} have an unmapped category and are{" "}
          <strong>grouped under &apos;Other&apos;</strong>. Map their categories in settings for an
          accurate breakdown.
        </Callout>
      )}

      {/* Ranked unit table */}
      <Surface
        title="Unit Rankings"
        description="Sortable by open tickets, in-window, or all-time. Filters apply client-side."
        actions={
          <div className="flex items-center gap-3">
            {analytics.isFetching && (
              <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
            )}
            <Segmented
              value={window}
              onChange={(v) => setWindow(v)}
              options={WINDOW_OPTIONS}
              size="sm"
              ariaLabel="Analysis window"
            />
          </div>
        }
      >
        {/* Filter row */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Search */}
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              placeholder="Search unit…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="unit-search"
              className="pl-8 pr-3 py-1.5 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] w-44"
            />
          </div>

          {/* Category filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            data-testid="category-filter"
            className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          >
            <option value="">All categories</option>
            {categoryOptions.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "open")}
            data-testid="status-filter"
            className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          >
            <option value="all">All statuses</option>
            <option value="open">Open only</option>
          </select>
        </div>

        {displayedRows.length === 0 ? (
          <Card className="border-border/50 bg-background/60 shadow-xl backdrop-blur-xl">
            <CardContent>
              <EmptyState
                icon={BarChart3}
                title="No ticket data"
                description="No tickets found for the selected window and property. Try widening the window or selecting a different property."
              />
            </CardContent>
          </Card>
        ) : (
          <UnitRankTable
            rows={displayedRows}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            onRowClick={setSelectedUnit}
          />
        )}
      </Surface>

      {/* Unit drill-down drawer (Task 3) */}
      <UnitDetailDrawer
        unit={selectedUnit}
        window={window}
        open={selectedUnit !== null}
        onClose={() => setSelectedUnit(null)}
      />
    </div>
  );
}
