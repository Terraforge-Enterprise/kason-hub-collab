// Owners tab (P4-owner-first front door) — the org-wide, OWNER-first landing.
//
// This is the default view of the admin Owner Ledger: the page is called
// "Owner Ledger", so it opens on owners. Unit lookup is preserved — the smart
// search matches owner name OR any of the owner's unit codes (Yannie's
// "unit is the reliable key" workflow still works from here), and each owner
// row expands to its per-unit sub-rows which deep-link to the unit workspace.
//
// Premium redesign (KAEN design language, per .claude/skills/frontend):
//   • GlowCard summary row — Owners · Gross · Expenses · Net payout · Pending,
//     aggregated over the currently-visible (post-search) owner set.
//   • Glassmorphism owner table with gold-tinted avatars, tabular money
//     columns, status pills, hover affordance, skeleton + empty states.
//
// Contract note (tests): the owner list stays a semantic <table> with
// aria-label="Owner summary"; owner rows carry aria-label={`Owner ${name}`};
// unit sub-rows carry aria-label={`Unit ${code} under ${name}`}; the search box
// keeps aria-label="Search owners or units". Do NOT rename these without
// updating owner-ledger-page.test.tsx.
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Building2,
  Calendar,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Receipt,
  Search,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TextInput } from "@/components/form-ui";
import { formatRM } from "@/components/format";
import { cn } from "@/lib/utils";
import { useOwnersSummary } from "@/api/owner-ledger";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Up to two uppercase initials for the avatar chip (e.g. "Tan Sri Lim" → "TL"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── Summary GlowCard row ─────────────────────────────────────────────────────

type SummaryTotals = {
  ownerCount: number;
  units: number;
  gross: number;
  expenses: number;
  net: number;
  pending: number;
};

function LoadingValue({ w = "w-24" }: { w?: string }) {
  return <span className={cn("inline-block h-8 rounded bg-muted animate-pulse", w)} />;
}

function OwnersSummaryCards({
  totals,
  isLoading,
}: {
  totals: SummaryTotals;
  isLoading: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      {/* Owners */}
      <GlowCard glowColor="purple" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Owners</p>
            <p className="text-3xl font-bold text-foreground tabular-nums">
              {isLoading ? <LoadingValue w="w-12" /> : totals.ownerCount}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Building2 className="h-3 w-3" />
              <span className="tabular-nums">{totals.units} units</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-purple-500/10">
            <Users className="h-6 w-6 text-purple-600" />
          </div>
        </div>
      </GlowCard>

      {/* Gross rental */}
      <GlowCard glowColor="green" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Gross rental</p>
            <p className="text-3xl font-bold text-emerald-500 tabular-nums">
              {isLoading ? <LoadingValue /> : formatRM(totals.gross)}
            </p>
            <div className="flex items-center gap-1 text-xs text-green-600">
              <TrendingUp className="h-3 w-3" />
              <span>Rent collected</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-green-500/10">
            <CircleDollarSign className="h-6 w-6 text-green-600" />
          </div>
        </div>
      </GlowCard>

      {/* Expenses */}
      <GlowCard glowColor="orange" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Expenses</p>
            <p className="text-3xl font-bold text-rose-400 tabular-nums">
              {isLoading ? <LoadingValue /> : formatRM(totals.expenses)}
            </p>
            <div className="flex items-center gap-1 text-xs text-orange-600">
              <TrendingDown className="h-3 w-3" />
              <span>Fees + deductions</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-orange-500/10">
            <Receipt className="h-6 w-6 text-orange-600" />
          </div>
        </div>
      </GlowCard>

      {/* Net payout */}
      <GlowCard glowColor="gold" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Net payout</p>
            <p className="text-3xl font-bold gold-text tabular-nums">
              {isLoading ? <LoadingValue /> : formatRM(totals.net)}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="h-3 w-3" />
              <span>Owed to owners</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-amber-500/10">
            <Wallet className="h-6 w-6 text-amber-600" />
          </div>
        </div>
      </GlowCard>

      {/* Pending */}
      <GlowCard glowColor="red" className="p-5 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Pending</p>
            <p
              className={cn(
                "text-3xl font-bold tabular-nums",
                totals.pending > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {isLoading ? <LoadingValue w="w-12" /> : totals.pending}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Awaiting action</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-red-500/10">
            <Clock className="h-6 w-6 text-red-600" />
          </div>
        </div>
      </GlowCard>
    </div>
  );
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

export function OwnersTab() {
  const navigate = useNavigate();

  const [ownerSearch, setOwnerSearch] = useState("");
  // Expand/collapse per-unit sub-rows for each owner row.
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());

  function toggleOwnerExpand(ownerPartyId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedOwners((prev) => {
      const next = new Set(prev);
      if (next.has(ownerPartyId)) next.delete(ownerPartyId);
      else next.add(ownerPartyId);
      return next;
    });
  }

  // Date range toggle: false = all-time (no dates sent); true = show pickers.
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");

  // Only pass months to the hook when the user has actively set them.
  const summaryFrom = dateRangeOpen && fromMonth ? fromMonth : undefined;
  const summaryTo = dateRangeOpen && toMonth ? toMonth : undefined;
  const ownersSummaryQuery = useOwnersSummary(summaryFrom, summaryTo);

  // Smart search: matches owner name OR any of the owner's unit codes.
  const ownerRows = useMemo(() => {
    const rows = ownersSummaryQuery.data?.data.owners ?? [];
    if (!ownerSearch.trim()) return rows;
    const q = ownerSearch.trim().toLowerCase();
    return rows.filter(
      (r) =>
        r.ownerName.toLowerCase().includes(q) ||
        (r.unitCodes ?? []).some((code) => code.toLowerCase().includes(q)),
    );
  }, [ownersSummaryQuery.data, ownerSearch]);

  // Aggregate totals over the currently-visible (post-search) owner set so the
  // summary row always matches the rows below it.
  const totals = useMemo<SummaryTotals>(() => {
    return ownerRows.reduce<SummaryTotals>(
      (acc, r) => {
        acc.ownerCount += 1;
        acc.units += r.unitCount;
        acc.gross += Number(r.grossRental);
        acc.expenses += Number(r.totalExpenses);
        acc.net += Number(r.netPayoutToOwner);
        acc.pending += r.pendingCount;
        return acc;
      },
      { ownerCount: 0, units: 0, gross: 0, expenses: 0, net: 0, pending: 0 },
    );
  }, [ownerRows]);

  const isLoading = ownersSummaryQuery.isLoading;

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Summary GlowCards */}
      <OwnersSummaryCards totals={totals} isLoading={isLoading} />

      {/* Search + optional date range */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Primary search — prominent, left-aligned, with leading icon */}
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <TextInput
              aria-label="Search owners or units"
              placeholder="Search by owner name or unit code…"
              value={ownerSearch}
              onChange={(e) => setOwnerSearch(e.target.value)}
              className="min-h-0 w-full py-2 pl-9"
            />
          </div>

          {/* Date range toggle */}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={dateRangeOpen}
            aria-controls="owner-date-range-panel"
            onClick={() => {
              setDateRangeOpen((v) => !v);
              // Clear months when collapsing so hook returns all-time again.
              if (dateRangeOpen) {
                setFromMonth("");
                setToMonth("");
              }
            }}
          >
            <Calendar className="h-4 w-4 mr-1" />
            Date range
            <ChevronDown
              className={`h-3.5 w-3.5 ml-1 transition-transform ${dateRangeOpen ? "rotate-180" : ""}`}
            />
          </Button>

          {/* Active date-range chip — renders whenever at least one month is set */}
          {dateRangeOpen && (fromMonth || toMonth) ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 border border-border/50 px-2.5 py-1 text-xs font-medium text-foreground">
              {fromMonth && toMonth
                ? `${fromMonth} – ${toMonth}`
                : fromMonth
                  ? `From ${fromMonth}`
                  : `Until ${toMonth}`}
              <button
                type="button"
                aria-label="Clear date range"
                onClick={() => {
                  setFromMonth("");
                  setToMonth("");
                  setDateRangeOpen(false);
                }}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>

        {/* Collapsible date pickers */}
        {dateRangeOpen && (
          <Card
            id="owner-date-range-panel"
            className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
          >
            <CardContent className="p-4 flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                  From
                </span>
                <TextInput
                  aria-label="From month"
                  type="month"
                  value={fromMonth}
                  onChange={(e) => setFromMonth(e.target.value)}
                  className="min-h-0 w-36 py-1.5"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                  To
                </span>
                <TextInput
                  aria-label="To month"
                  type="month"
                  value={toMonth}
                  onChange={(e) => setToMonth(e.target.value)}
                  className="min-h-0 w-36 py-1.5"
                />
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Owners summary table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-0">
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table
              className="min-w-full border-collapse text-left text-sm"
              role="table"
              aria-label="Owner summary"
            >
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Owner</th>
                  <th className="px-4 py-3 font-semibold text-right">Units</th>
                  <th className="px-4 py-3 font-semibold text-right">Gross</th>
                  <th className="px-4 py-3 font-semibold text-right">Expenses</th>
                  <th className="px-4 py-3 font-semibold text-right">Net payout</th>
                  <th className="px-4 py-3 font-semibold text-right">Pending</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  // Skeleton rows matching the column layout.
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={`sk-${i}`} className="border-b border-[var(--border)]">
                      <td className="px-4 py-3.5" colSpan={6}>
                        <div className="h-5 w-full animate-pulse rounded bg-muted" />
                      </td>
                    </tr>
                  ))
                ) : ownerRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Users className="h-8 w-8 opacity-40" />
                        <p className="text-sm font-medium">No owners found.</p>
                        <p className="text-xs">
                          {ownerSearch.trim()
                            ? "Try a different owner name or unit code."
                            : "Owner rows appear once ledger entries exist."}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  ownerRows.map((row) => {
                    const rowUnits = row.units ?? [];
                    const isExpanded = expandedOwners.has(row.ownerPartyId);
                    return (
                      <Fragment key={row.ownerPartyId}>
                        {/* ── Owner summary row ─────────────────────────── */}
                        <tr
                          role="row"
                          aria-label={`Owner ${row.ownerName}`}
                          className="group border-b border-[var(--border)] transition hover:bg-[var(--page-bg)] cursor-pointer"
                          onClick={() => navigate(`/tenancy/owner-ledger/${row.ownerPartyId}`)}
                        >
                          <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                            <div className="flex items-center gap-2.5">
                              {/* Expand/collapse toggle — only when sub-units exist */}
                              {rowUnits.length > 0 ? (
                                <button
                                  type="button"
                                  aria-label={
                                    isExpanded
                                      ? `Collapse units for ${row.ownerName}`
                                      : `Expand units for ${row.ownerName}`
                                  }
                                  aria-expanded={isExpanded}
                                  onClick={(e) => toggleOwnerExpand(row.ownerPartyId, e)}
                                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </button>
                              ) : (
                                <span className="w-5 shrink-0" aria-hidden="true" />
                              )}
                              {/* Gold-tinted initials avatar */}
                              <div
                                aria-hidden="true"
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--gold-dark)] to-[var(--gold-light)] text-xs font-bold text-white shadow-sm"
                              >
                                {initials(row.ownerName)}
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium truncate">{row.ownerName}</div>
                                <div className="text-xs text-muted-foreground">
                                  {row.lastEntryMonth
                                    ? `Last entry: ${row.lastEntryMonth}`
                                    : "No entries yet"}
                                </div>
                              </div>
                            </div>
                          </td>
                          {/* Units */}
                          <td className="px-4 py-3.5 text-sm text-[var(--text-primary)] text-right">
                            <span className="tabular-nums font-medium">{row.unitCount}</span>
                          </td>
                          {/* Gross */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums text-emerald-500 font-semibold">
                              {formatRM(Number(row.grossRental))}
                            </span>
                          </td>
                          {/* Expenses */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums text-rose-400 font-semibold">
                              {formatRM(Number(row.totalExpenses))}
                            </span>
                          </td>
                          {/* Net payout */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <span className="tabular-nums font-bold">
                              {formatRM(Number(row.netPayoutToOwner))}
                            </span>
                          </td>
                          {/* Pending + hover affordance */}
                          <td className="px-4 py-3.5 text-sm text-right">
                            <div className="flex items-center justify-end gap-2">
                              {row.pendingCount > 0 ? (
                                <Badge variant="amber" className="tabular-nums">
                                  {row.pendingCount}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground tabular-nums">—</span>
                              )}
                              <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                            </div>
                          </td>
                        </tr>

                        {/* ── Per-unit sub-rows (indented, shown when expanded) ── */}
                        {isExpanded &&
                          rowUnits.map((unit) => (
                            <tr
                              key={`${row.ownerPartyId}-${unit.apartmentId}`}
                              role="row"
                              aria-label={`Unit ${unit.unitCode} under ${row.ownerName}`}
                              className="border-b border-[var(--border)] bg-muted/20 cursor-pointer transition hover:bg-muted/40"
                              onClick={() =>
                                // P4: unit sub-rows land on the unit workspace.
                                navigate(`/tenancy/owner-ledger/unit/${unit.apartmentId}`)
                              }
                            >
                              {/* Unit code — indented under owner name column */}
                              <td className="py-2.5 pl-16 pr-4 text-sm text-[var(--text-primary)]">
                                <div className="flex items-center gap-1.5">
                                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="text-xs font-medium tabular-nums">
                                    {unit.unitCode}
                                  </span>
                                </div>
                              </td>
                              {/* Units column — blank for sub-row */}
                              <td className="px-4 py-2.5 text-right text-sm text-muted-foreground">
                                —
                              </td>
                              {/* Gross */}
                              <td className="px-4 py-2.5 text-right text-sm">
                                <span className="tabular-nums text-xs text-emerald-500">
                                  {formatRM(Number(unit.grossRental))}
                                </span>
                              </td>
                              {/* Expenses */}
                              <td className="px-4 py-2.5 text-right text-sm">
                                <span className="tabular-nums text-xs text-rose-400">
                                  {formatRM(Number(unit.totalExpenses))}
                                </span>
                              </td>
                              {/* Net payout */}
                              <td className="px-4 py-2.5 text-right text-sm">
                                <span className="tabular-nums text-xs font-semibold">
                                  {formatRM(Number(unit.netPayoutToOwner))}
                                </span>
                              </td>
                              {/* Navigate hint */}
                              <td className="px-4 py-2.5 text-right text-sm">
                                <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
