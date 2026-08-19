// Units tab (P4 unit-first owner ledger) — the org-wide, unit-first front door.
//
// Property rail (tracker PropertyRail PATTERN, spec §4.8: vertical ≥lg, chip
// bar <lg — re-implemented lightweight here because the tracker component is
// typed to TrackerPropertySummary counts) + month picker (defaults current
// month) + server-side unit search + paginated table backed by
// GET /owner-ledger/units-summary. "Unassigned / property-level" residual rows
// (apartmentId null) render as muted non-clickable rows. Row click →
// /tenancy/owner-ledger/unit/:apartmentId (Task 7 workspace).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, FileText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui";
import { TextInput } from "@/components/form-ui";
import { formatRM, getStatusTone } from "@/components/format";
import { labelFor } from "@/lib/string-utils";
import { apiFetch } from "@/lib/api-client";
import { currentMonth } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { useOrgUnitsSummary, type OrgUnitSummaryRow } from "@/api/owner-ledger";

const PAGE_SIZE = 20;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ─── Property rail (tracker pattern, counts-free) ────────────────────────────

function RailEntry({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        isActive && "bg-[var(--sidebar-active-bg)] font-semibold text-[var(--gold)]",
        !isActive && "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function LedgerPropertyRail({
  properties,
  selected,
  onSelect,
}: {
  properties: Array<{ id: string; name: string }>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const entries = (
    <>
      <RailEntry label="All properties" isActive={selected === ""} onClick={() => onSelect("")} />
      {properties.map((p) => (
        <RailEntry key={p.id} label={p.name} isActive={selected === p.id} onClick={() => onSelect(p.id)} />
      ))}
    </>
  );
  return (
    <>
      {/* ≥lg: vertical rail */}
      <nav aria-label="Properties" className="hidden w-[200px] shrink-0 space-y-1 lg:block">
        <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Properties
        </div>
        {entries}
      </nav>
      {/* <lg: horizontal chip bar (same buttons, scrollable) */}
      <nav
        aria-label="Properties"
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:hidden [&>button]:w-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap"
      >
        {entries}
      </nav>
    </>
  );
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

export function UnitsTab() {
  const navigate = useNavigate();

  const [month, setMonth] = useState<string>(currentMonth);
  const [search, setSearch] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounced(search.trim(), 300);

  // Shared queryKey with the page's property fetch → cache hit, no extra call.
  const propertiesQuery = useQuery({
    queryKey: ["properties"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string }> }>("/inventory/properties"),
  });
  const properties = propertiesQuery.data?.data ?? [];

  const summaryQuery = useOrgUnitsSummary({
    month: `${month}-01`,
    q: debouncedSearch || undefined,
    propertyId: propertyId || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const items = summaryQuery.data?.data.items ?? [];
  const total = summaryQuery.data?.data.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasNextPage = page < totalPages;

  function resetPage() {
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <LedgerPropertyRail
        properties={properties}
        selected={propertyId}
        onSelect={(id) => {
          setPropertyId(id);
          resetPage();
        }}
      />

      <div className="min-w-0 flex-1 space-y-4">
        {/* Month + search controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
              Month
            </span>
            <TextInput
              aria-label="Ledger month"
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                resetPage();
              }}
              className="min-h-0 w-40 py-1.5"
            />
          </div>
          <TextInput
            aria-label="Search units"
            placeholder="Search by unit code or property…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPage();
            }}
            className="min-h-0 w-72 py-1.5"
          />
        </div>

        {/* Units table */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-0">
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table
                className="min-w-full border-collapse text-left text-sm"
                role="table"
                aria-label="Units summary"
              >
                <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Unit</th>
                    <th className="px-4 py-3 font-semibold">Owner</th>
                    <th className="px-4 py-3 font-semibold text-right">Occupancy</th>
                    <th className="px-4 py-3 font-semibold text-right">Income</th>
                    <th className="px-4 py-3 font-semibold text-right">Expenses</th>
                    <th className="px-4 py-3 font-semibold text-right">Net</th>
                    <th className="px-4 py-3 font-semibold">Statement</th>
                    <th className="px-4 py-3 font-semibold text-right">Open docs</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                        {summaryQuery.isLoading ? "Loading units…" : "No units found."}
                      </td>
                    </tr>
                  ) : (
                    items.map((row: OrgUnitSummaryRow) => {
                      const isReal = row.apartmentId != null;
                      return (
                        <tr
                          key={row.apartmentId ?? `unassigned-${row.propertyId}`}
                          role="row"
                          aria-label={
                            isReal
                              ? `Unit ${row.unitCode}`
                              : `Unassigned · ${row.propertyName}`
                          }
                          className={cn(
                            "border-b border-[var(--border)] transition",
                            isReal
                              ? "cursor-pointer hover:bg-[var(--page-bg)]"
                              : "bg-muted/20",
                          )}
                          onClick={
                            isReal
                              ? () => navigate(`/tenancy/owner-ledger/unit/${row.apartmentId}`)
                              : undefined
                          }
                        >
                          {/* Unit */}
                          <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                            <div className="flex items-center gap-1.5">
                              <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <div>
                                <div className="font-medium tabular-nums">
                                  {isReal ? row.unitCode : "Unassigned / property-level"}
                                </div>
                                <div className="text-xs text-muted-foreground">{row.propertyName}</div>
                              </div>
                            </div>
                          </td>
                          {/* Owner */}
                          <td className="px-4 py-3.5 text-sm">
                            {row.ownerPartyId ? (
                              <button
                                type="button"
                                className="text-[var(--gold)] hover:underline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/tenancy/owner-ledger/${row.ownerPartyId}`);
                                }}
                              >
                                {row.ownerName}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          {/* Occupancy */}
                          <td className="px-4 py-3.5 text-sm text-right tabular-nums">
                            {isReal ? (
                              row.occupancy.activeTenancies > 0 ? (
                                `${row.occupancy.activeTenancies} active`
                              ) : (
                                <span className="text-muted-foreground">Vacant</span>
                              )
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          {/* Income */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums text-emerald-500">
                              {formatRM(Number(row.figures.income))}
                            </span>
                          </td>
                          {/* Expenses */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums text-rose-400">
                              {formatRM(Number(row.figures.expenses))}
                            </span>
                          </td>
                          {/* Net */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums font-semibold">
                              {formatRM(Number(row.figures.netPayout))}
                            </span>
                          </td>
                          {/* Statement chip */}
                          <td className="px-4 py-3.5">
                            {row.statement ? (
                              <StatusPill tone={getStatusTone(row.statement.status)}>
                                {labelFor(row.statement.status)}
                              </StatusPill>
                            ) : (
                              <span className="text-muted-foreground text-xs inline-flex items-center gap-1">
                                <FileText className="h-3 w-3" /> —
                              </span>
                            )}
                          </td>
                          {/* Open docs */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            {row.openDocuments > 0 ? (
                              <Badge variant="amber" className="tabular-nums">
                                {row.openDocuments}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground tabular-nums">—</span>
                            )}
                            {isReal && (
                              <ChevronRight className="ml-2 inline h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Pagination */}
        {(page > 1 || hasNextPage) && (
          <div className="flex items-center justify-end gap-3">
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages} &bull; {total} units
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1 || summaryQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNextPage || summaryQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
