// Admin page — Sales Claims list. Editor+ access (server enforces).
// Editors see metadata-only rows; manager+ see commission amounts. Approve /
// reject / needs-amendment buttons live on the detail page (manager+).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardList, Receipt, TrendingUp } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { useAuth } from "@/lib/auth";
import { formatRM } from "@/components/format";
import {
  listSalesClaims,
  type SalesClaim,
  type SalesClaimStatus,
} from "@/api/sales-claims";
import { statusBadgeVariant, statusLabel } from "./status-helpers";

const STATUS_OPTIONS: { value: SalesClaimStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "needs_amendment", label: "Needs amendment" },
];

export default function SalesClaimsPage() {
  const { user } = useAuth();
  const isEditor = user?.role === "editor";

  const [filterStatus, setFilterStatus] =
    useState<SalesClaimStatus | "all">("all");
  const [salesUnitId, setSalesUnitId] = useState("");
  const [submittedById, setSubmittedById] = useState("");
  const [submittedFrom, setSubmittedFrom] = useState("");
  const [submittedTo, setSubmittedTo] = useState("");

  const apiFilters = useMemo(() => {
    return {
      ...(filterStatus !== "all" ? { status: filterStatus } : {}),
      ...(isUuid(salesUnitId) ? { salesUnitId } : {}),
      ...(isUuid(submittedById) ? { submittedById } : {}),
      ...(submittedFrom ? { submittedFrom: toIsoStartOfDay(submittedFrom) } : {}),
      ...(submittedTo ? { submittedTo: toIsoEndOfDay(submittedTo) } : {}),
    };
  }, [filterStatus, salesUnitId, submittedById, submittedFrom, submittedTo]);

  const claims = useQuery({
    queryKey: ["sales", "claims", apiFilters],
    queryFn: () => listSalesClaims(apiFilters),
    placeholderData: (prev) => prev,
  });

  const stats = useMemo(() => computeStats(claims.data ?? []), [claims.data]);

  if (claims.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-64 bg-muted rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]"
            />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (claims.isError) {
    return (
      <Callout variant="danger" title="Failed to load claims">
        Unable to load sales claims. Please refresh.
      </Callout>
    );
  }

  const rows = claims.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Receipt className="h-8 w-8 text-primary" />
          Sales Claims
        </h1>
        <p className="text-muted-foreground mt-1">
          Sales commission claims linked to Sales Entries. Review commission
          types, splits, and statuses.
        </p>
      </div>

      {isEditor && (
        <Callout variant="info" title="Editor view">
          Commission amounts and splits are hidden. Approve and reject
          controls are limited to managers and admins.
        </Callout>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total</p>
              <p className="text-3xl font-bold text-foreground">{rows.length}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClipboardList className="h-3 w-3" />
                <span>visible claims</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <ClipboardList className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Pending review</p>
              <p className="text-3xl font-bold text-foreground">{stats.pending}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>submitted + pending approval</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <TrendingUp className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="purple"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Needs amendment</p>
              <p className="text-3xl font-bold text-foreground">{stats.needsAmendment}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>awaiting agent fix</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-purple-500/10">
              <ClipboardList className="h-6 w-6 text-purple-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Approved</p>
              <p className="text-3xl font-bold text-foreground">{stats.approved}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>terminal · approved</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Receipt className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Filters */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5 w-fit">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setFilterStatus(s.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  filterStatus === s.value
                    ? "bg-[var(--gold)]/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <FilterField label="Sales Unit ID">
              <Input
                value={salesUnitId}
                onChange={(e) => setSalesUnitId(e.target.value)}
                placeholder="UUID"
              />
            </FilterField>
            <FilterField label="Submitted by (user ID)">
              <Input
                value={submittedById}
                onChange={(e) => setSubmittedById(e.target.value)}
                placeholder="UUID"
              />
            </FilterField>
            <FilterField label="Submitted from">
              <Input
                type="date"
                value={submittedFrom}
                onChange={(e) => setSubmittedFrom(e.target.value)}
              />
            </FilterField>
            <FilterField label="Submitted to">
              <Input
                type="date"
                value={submittedTo}
                onChange={(e) => setSubmittedTo(e.target.value)}
              />
            </FilterField>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Claim
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Sales unit
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Commission type
                  </th>
                  {!isEditor && (
                    <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                      Computed
                    </th>
                  )}
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Payment
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Submitted
                  </th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    Status
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isEditor ? 7 : 8}
                      className="px-4 py-12 text-center text-sm text-muted-foreground"
                    >
                      No sales claims match the current filters.
                    </td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <ClaimRow key={c.id} claim={c} isEditor={isEditor} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ClaimRow({
  claim,
  isEditor,
}: {
  claim: SalesClaim;
  isEditor: boolean;
}) {
  return (
    <tr className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]">
      <td className="px-4 py-3.5 text-sm">
        <Link
          to={`/sales/claims/${claim.id}`}
          className="font-mono text-xs text-foreground hover:underline group inline-flex items-center gap-1"
        >
          {claim.id.slice(0, 8)}…
          <ArrowUpRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition" />
        </Link>
      </td>
      <td className="px-4 py-3.5 text-sm font-mono text-xs text-muted-foreground">
        {claim.salesUnitId.slice(0, 8)}…
      </td>
      <td className="px-4 py-3.5 text-sm">
        {claim.commissionType === "percent_of_purchase"
          ? "% of purchase"
          : "Fixed"}
      </td>
      {!isEditor && (
        <td className="px-4 py-3.5 text-sm text-right font-medium">
          {claim.computedAmount != null
            ? formatRM(claim.computedAmount)
            : "—"}
        </td>
      )}
      <td className="px-4 py-3.5 text-sm capitalize">{claim.paymentType}</td>
      <td className="px-4 py-3.5 text-sm">
        <div>{new Date(claim.submittedAt).toLocaleDateString("en-MY")}</div>
        <div className="text-xs text-muted-foreground font-mono">
          {claim.submittedById.slice(0, 8)}…
        </div>
      </td>
      <td className="px-4 py-3.5 text-sm">
        <Badge variant={statusBadgeVariant(claim.status)}>
          {statusLabel(claim.status)}
        </Badge>
      </td>
      <td className="px-4 py-3.5 text-right">
        <Link
          to={`/sales/claims/${claim.id}`}
          className="text-xs font-medium text-primary hover:underline"
        >
          View
        </Link>
      </td>
    </tr>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function computeStats(rows: SalesClaim[]) {
  let pending = 0;
  let approved = 0;
  let needsAmendment = 0;
  for (const r of rows) {
    if (r.status === "submitted" || r.status === "pending_approval") pending++;
    if (r.status === "approved") approved++;
    if (r.status === "needs_amendment") needsAmendment++;
  }
  return { pending, approved, needsAmendment };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

function toIsoStartOfDay(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`).toISOString();
}

function toIsoEndOfDay(yyyyMmDd: string): string {
  return new Date(`${yyyyMmDd}T23:59:59.999Z`).toISOString();
}
