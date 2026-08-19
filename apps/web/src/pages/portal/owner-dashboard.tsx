import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { labelFor } from "@/lib/string-utils";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui";
import { Callout } from "@/components/ui/callout";
import type { PortalOwnerDashboardResponse } from "@kason/shared";
import { useOwnerLedger, type OwnerLedgerRowDto } from "@/api/portal-owner-ledger";
import {
  ownerLedgerRowStatus,
  groupByDirection,
} from "../tenancy/owner-ledger/ledger-presentation";
import {
  TrendingUp,
  TrendingDown,
  CircleDollarSign,
  Home,
  Building2,
  CreditCard,
  Receipt,
  Wallet,
  ArrowDownCircle,
  FileText,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ScrollText,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function defaultFromMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-01`;
}

/** Parse a decimal string from the API and coerce to number for formatRM. */
function toNum(s: string | null | undefined): number {
  if (!s) return 0;
  return parseFloat(s) || 0;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OwnerDashboardPage() {
  // ── Selectors ──────────────────────────────────────────────────────────────
  const [fromMonth, setFromMonth] = useState(defaultFromMonth);
  const [toMonth, setToMonth] = useState(currentYearMonth);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | undefined>(undefined);
  const [expandBreakdown, setExpandBreakdown] = useState(false);

  // ── Dashboard data (occupancy, properties, recent transactions) ────────────
  const { data, isLoading: dashLoading, error } = useQuery({
    queryKey: ["portal-owner-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalOwnerDashboardResponse }>("/dashboard"),
  });

  // ── Owner ledger for KPI money figures ─────────────────────────────────────
  const ledgerQuery = useOwnerLedger(fromMonth, toMonth, selectedPropertyId);
  const summary = ledgerQuery.data?.data?.summary;
  const ledgerRows = ledgerQuery.data?.data?.rows ?? [];

  // ── Ledger detail grouping (owner-ledger view clarity, Task 5) ─────────────
  // groupByDirection returns ONLY {income, expenses} — it drops payout-direction
  // rows, so they are carved out separately into their own section below rather
  // than silently disappearing (mirrors owner-workspace.tsx's Task 4 pattern).
  const { income, expenses } = groupByDirection(ledgerRows);
  const payouts = ledgerRows.filter((r) => r.direction === "payout");

  // ── Derived occupancy values (from dashboard data) ──────────────────────────
  const d = data?.data;
  const occupancyPct = d && d.occupancy.total > 0 ? Math.round(d.occupancy.rate * 100) : 0;
  const vacantUnits = d ? d.occupancy.total - d.occupancy.occupied : 0;

  // ── Next-expiring tenancy (earliest endDate from recent transactions unitCode
  //    isn't available in dashboard, so derive from occupancy data gracefully) ─
  // The dashboard response doesn't include endDate — this is graceful omission.

  // ── Per-property ledger breakdown (grouped from rows) ──────────────────────
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- deliberate: manual useMemo grouping retained; deps are the real inputs
  const perPropertyBreakdown = useMemo(() => {
    if (!ledgerRows.length || !d?.properties.length) return null;
    // Group row amounts by propertyId
    const incomeByProp: Record<string, number> = {};
    const expenseByProp: Record<string, number> = {};
    for (const row of ledgerRows) {
      if (row.direction === "income") {
        incomeByProp[row.propertyId] = (incomeByProp[row.propertyId] ?? 0) + parseFloat(row.amount);
      } else if (row.direction === "expense") {
        expenseByProp[row.propertyId] = (expenseByProp[row.propertyId] ?? 0) + parseFloat(row.amount);
      }
    }
    // Match property names from dashboard data
    const propMap = Object.fromEntries(d.properties.map((p) => [p.id, p.name]));
    const propIds = [...new Set(ledgerRows.map((r) => r.propertyId))];
    if (propIds.length <= 1) return null; // nothing useful to break down
    return propIds.map((pid) => ({
      id: pid,
      name: propMap[pid] ?? pid,
      income: incomeByProp[pid] ?? 0,
      expenses: expenseByProp[pid] ?? 0,
      net: (incomeByProp[pid] ?? 0) - (expenseByProp[pid] ?? 0),
    }));
  }, [ledgerRows, d?.properties]);

  // ── Latest statement month (most recent statementMonth from ledger rows) ───
  const latestStatementMonth = useMemo(() => {
    if (!ledgerRows.length) return null;
    const months = ledgerRows.map((r) => r.statementMonth).sort().reverse();
    return months[0] ?? null;
  }, [ledgerRows]);

  if (dashLoading) return <DashboardSkeleton />;
  if (error) {
    return <p className="text-sm text-red-400">{(error as Error).message}</p>;
  }
  if (!d) return null;

  const isLedgerLoading = ledgerQuery.isLoading || ledgerQuery.isFetching;

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Building2 className="h-8 w-8 text-primary" />
            Portfolio Overview
          </h1>
          <p className="text-muted-foreground mt-1">
            <span className="gold-text font-semibold">{d.propertyCount}</span>{" "}
            {d.propertyCount === 1 ? "property" : "properties"} · At-a-glance KPIs
          </p>
        </div>

        {/* ── Selectors ── */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Property selector — only when multiple properties */}
          {d.properties.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground whitespace-nowrap">Property</label>
              <select
                value={selectedPropertyId ?? ""}
                onChange={(e) => setSelectedPropertyId(e.target.value || undefined)}
                aria-label="Filter by property"
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
              >
                <option value="">All properties</option>
                {d.properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* From month */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
            <input
              type="month"
              value={fromMonth}
              onChange={(e) => setFromMonth(e.target.value)}
              aria-label="From month"
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* To month */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
            <input
              type="month"
              value={toMonth}
              onChange={(e) => setToMonth(e.target.value)}
              aria-label="To month"
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      {/* ── Row 1: KPI GlowCards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Gross Rental */}
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Gross Rental</p>
              <p className="text-3xl font-bold text-emerald-500">
                {isLedgerLoading ? (
                  <span className="inline-block h-9 w-28 bg-muted rounded animate-pulse" />
                ) : (
                  formatRM(toNum(summary?.grossRental))
                )}
              </p>
              <div className="flex items-center gap-1 text-xs text-green-600">
                <TrendingUp className="h-3 w-3" />
                <span>Total rent collected</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <CircleDollarSign className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>

        {/* Total Expenses */}
        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total Expenses</p>
              <p className="text-3xl font-bold text-orange-500">
                {isLedgerLoading ? (
                  <span className="inline-block h-9 w-28 bg-muted rounded animate-pulse" />
                ) : (
                  formatRM(toNum(summary?.totalExpenses))
                )}
              </p>
              <div className="flex items-center gap-1 text-xs text-orange-600">
                <TrendingDown className="h-3 w-3" />
                <span>Fees + deductions</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <TrendingDown className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>

        {/* Net Payout — highlighted */}
        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 ring-1 ring-amber-500/30"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Net Payout</p>
              <p className="text-3xl font-bold text-amber-500">
                {isLedgerLoading ? (
                  <span className="inline-block h-9 w-28 bg-muted rounded animate-pulse" />
                ) : (
                  formatRM(toNum(summary?.netPayoutToOwner))
                )}
              </p>
              <div className="flex items-center gap-1 text-xs text-amber-600">
                <ArrowDownCircle className="h-3 w-3" />
                <span>Remitted to you</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Wallet className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>

        {/* Occupancy */}
        <GlowCard
          glowColor="blue"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Occupancy</p>
              <p className="text-3xl font-bold text-foreground">{occupancyPct}%</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Home className="h-3 w-3" />
                <span>{d.occupancy.occupied}/{d.occupancy.total} units occupied</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-blue-500/10">
              <Home className="h-6 w-6 text-blue-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* ── Row 2: Secondary KPIs ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Latest Statement Month */}
        <GlowCard
          glowColor="purple"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Latest Statement</p>
              <p className="text-2xl font-bold text-foreground">
                {isLedgerLoading ? (
                  <span className="inline-block h-8 w-24 bg-muted rounded animate-pulse" />
                ) : latestStatementMonth ? (
                  latestStatementMonth
                ) : (
                  "—"
                )}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" />
                <span>Most recent period</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-purple-500/10">
              <FileText className="h-6 w-6 text-purple-600" />
            </div>
          </div>
        </GlowCard>

        {/* Vacant Units — occupied/vacant count snapshot */}
        <GlowCard
          glowColor="orange"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Vacant Units</p>
              {/* Dashboard response doesn't include endDate — show vacant count instead */}
              <p className="text-2xl font-bold text-foreground">
                {vacantUnits > 0 ? (
                  <span className="text-rose-500">{vacantUnits} vacant</span>
                ) : (
                  <span className="text-emerald-500">All occupied</span>
                )}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                <span>Current occupancy status</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <CalendarClock className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>

        {/* Download Annual Report CTA */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl flex flex-col justify-between p-5">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Annual Report</p>
            <p className="text-xs text-muted-foreground">
              Income &amp; Tax summary for filing purposes
            </p>
          </div>
          <Link
            to="/portal/income-tax"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg h-7 px-2.5 text-[0.8rem] font-medium bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] text-white shadow-[0_8px_24px_-8px_rgba(212,175,55,0.4)] hover:shadow-[0_12px_28px_-6px_rgba(212,175,55,0.5)] transition-shadow"
          >
            <FileText className="h-3.5 w-3.5" />
            Download Annual Report
          </Link>
        </Card>
      </div>

      {/* ── Per-property breakdown (expandable, only when multiple properties) ── */}
      {perPropertyBreakdown && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-3">
            <button
              type="button"
              onClick={() => setExpandBreakdown((v) => !v)}
              aria-expanded={expandBreakdown}
              className="flex items-center justify-between w-full text-left group"
            >
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" />
                Per-Property Breakdown
                <Badge variant="secondary" className="text-xs ml-1">{perPropertyBreakdown.length} properties</Badge>
              </CardTitle>
              {expandBreakdown ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition" />
              )}
            </button>
          </CardHeader>
          {expandBreakdown && (
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {perPropertyBreakdown.map((prop) => (
                  <div
                    key={prop.id}
                    className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2"
                  >
                    <p className="text-sm font-semibold text-foreground truncate" title={prop.name}>
                      {prop.name}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Income</p>
                        <p className="text-sm font-medium text-emerald-600">{formatRM(prop.income)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Expenses</p>
                        <p className="text-sm font-medium text-rose-600">{formatRM(prop.expenses)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Net</p>
                        <p className={`text-sm font-medium ${prop.net >= 0 ? "text-foreground" : "text-rose-600"}`}>
                          {formatRM(prop.net)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Row 3: Properties + Recent Transactions ────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Properties
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.properties.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10">
                  <Building2 className="h-7 w-7 text-amber-600" />
                </div>
                <p className="mt-4 text-lg font-semibold text-foreground">No properties</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Properties assigned to you will appear here.
                </p>
              </div>
            ) : (
              d.properties.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm text-foreground block">{p.name}</span>
                      <span className="text-xs text-muted-foreground block">
                        {p.occupiedCount}/{p.unitCount} units occupied
                      </span>
                    </div>
                  </div>
                  <Badge
                    variant={
                      p.occupiedCount === p.unitCount ? "emerald" :
                      p.occupiedCount === 0 ? "rose" :
                      "amber"
                    }
                  >
                    {p.occupiedCount === p.unitCount ? "Full" :
                     p.occupiedCount === 0 ? "Vacant" :
                     `${p.unitCount - p.occupiedCount} vacant`}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Receipt className="h-5 w-5 text-primary" />
              Recent Transactions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.recentTransactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10">
                  <Receipt className="h-7 w-7 text-amber-600" />
                </div>
                <p className="mt-4 text-lg font-semibold text-foreground">No recent transactions</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Tenant payments will appear here.
                </p>
              </div>
            ) : (
              d.recentTransactions.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <CreditCard className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm text-foreground block">{t.tenantName}</span>
                      <span className="text-xs text-muted-foreground block">{formatDate(t.receivedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-medium text-foreground">{formatRM(t.amount)}</span>
                    <Badge variant="emerald">Received</Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Ledger Entries (grouped Income/Expenses/Payouts; owner-ledger view
             clarity, Task 5). Hidden entirely when the range has no rows at all;
             each sub-section additionally hides itself when its own group is
             empty (R4: "Empty sections are hidden"). ── */}
      {(income.length > 0 || expenses.length > 0 || payouts.length > 0) && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <ScrollText className="h-5 w-5 text-primary" />
              Ledger Entries
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {income.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Income (money in)
                </h4>
                <LedgerRowList rows={income} />
              </div>
            )}
            {expenses.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Expenses (paid by KAEN, deducted from payout)
                </h4>
                <Callout variant="info">
                  Utilities show the full supplier bill; the tenant&apos;s share appears
                  as income above, so your net cost is the difference.
                </Callout>
                <LedgerRowList rows={expenses} />
              </div>
            )}
            {payouts.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Payouts
                </h4>
                {/* Payouts NEVER resolve status via ownerLedgerRowStatus: a real payout
                    row always has includeInPayout:false (same as an owner-paid expense),
                    which would mislabel it "Owner-paid". Use the original
                    getStatusTone/labelFor(paymentStatus) resolution instead. */}
                <LedgerRowList
                  rows={payouts}
                  resolveStatus={(row) => ({
                    tone: getStatusTone(row.paymentStatus),
                    label: labelFor(row.paymentStatus),
                  })}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Ledger row list (Income/Expenses/Payouts sections above) ────────────────

/**
 * One direction-group's rows, rendered as list-item cards (mirrors the Recent
 * Transactions row pattern on this same page). `resolveStatus` defaults to
 * `ownerLedgerRowStatus` (Income/Expenses' behavior); the Payouts section
 * overrides it with getStatusTone(paymentStatus)/labelFor — see the Payouts
 * call site for why ownerLedgerRowStatus would mislabel a payout row.
 */
function LedgerRowList({
  rows,
  resolveStatus = ownerLedgerRowStatus,
}: {
  rows: OwnerLedgerRowDto[];
  resolveStatus?: (row: OwnerLedgerRowDto) => ReturnType<typeof ownerLedgerRowStatus>;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const st = resolveStatus(row);
        return (
          <div
            key={row.id}
            className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm"
          >
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <span className="text-sm text-foreground block truncate">
                  {row.description ?? labelFor(row.category)}
                </span>
                <span className="text-xs text-muted-foreground block">
                  {formatDate(row.transactionDate)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-medium text-foreground">
                {formatRM(toNum(row.amount))}
              </span>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-80 bg-muted rounded" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-48 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
      </div>
    </div>
  );
}
