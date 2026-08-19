/**
 * Portal — Sales Commission Claims (agent-facing, READ-ONLY list).
 *
 * Plan 2: this page is now a read-only list of the agent's sales claims.
 * Filing happens in the unified Pipeline at /portal/pipeline?tab=sales —
 * which auto-derives a SalesClaimDefault per Plan 1, removing the need for
 * a separate filing drawer here.
 *
 * Hard rules retained from W2c:
 *   - List + status filter only. No create/edit/withdraw on this page.
 *   - "+ New Sales Entry" CTA links to the Pipeline (Sales tab).
 *   - /portal/sales-claims/new now redirects to the Pipeline (router.tsx).
 *   - Backend `/portal-api/sales-claims/*` endpoints stay 100% intact —
 *     this is a frontend trim only.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  CheckCircle2,
  ClipboardList,
  Coins,
  PlusCircle,
  Receipt,
  TriangleAlert,
} from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRM } from "@/components/format";
import {
  listOwnSalesClaims,
  listOwnSalesUnits,
  type SalesClaimStatus,
} from "@/api/portal-sales-claims";

// ─── Status presentation ─────────────────────────────────────────────────────

const STATUS_LABEL: Record<SalesClaimStatus, string> = {
  submitted: "Submitted",
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  needs_amendment: "Needs Amendment",
};

const STATUS_VARIANT: Record<
  SalesClaimStatus,
  "sky" | "amber" | "emerald" | "rose"
> = {
  submitted: "sky",
  pending_approval: "amber",
  approved: "emerald",
  rejected: "rose",
  needs_amendment: "amber",
};

const STATUS_FILTERS: Array<SalesClaimStatus | "all"> = [
  "all",
  "submitted",
  "pending_approval",
  "approved",
  "needs_amendment",
  "rejected",
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function SalesClaimsPage() {
  const [statusFilter, setStatusFilter] = useState<SalesClaimStatus | "all">(
    "all",
  );

  // List query — own claims via portal own-only route (forceFullSelect on the server).
  const { data: claimsData, isLoading: claimsLoading } = useQuery({
    queryKey: ["portal-sales-claims", statusFilter],
    queryFn: () =>
      listOwnSalesClaims(
        statusFilter === "all" ? undefined : { status: statusFilter },
      ),
  });

  // Sales units query — drives the unit-number/purchase-price column on each
  // row. Read-only; no longer needed for a filing drawer (Pipeline owns that).
  const { data: unitsData } = useQuery({
    queryKey: ["portal-sales-claims-units"],
    queryFn: () => listOwnSalesUnits(),
  });

  const claims = claimsData?.data ?? [];
  const units = unitsData?.data ?? [];

  // Stats (derived from the unfiltered list-current-page; status filter
  // applied client-side so the cards never flicker between filters).
  const stats = useMemo(() => {
    const allClaims = claims;
    return {
      total: allClaims.length,
      pending: allClaims.filter(
        (c) => c.status === "submitted" || c.status === "pending_approval",
      ).length,
      approved: allClaims.filter((c) => c.status === "approved").length,
      needsAmend: allClaims.filter((c) => c.status === "needs_amendment").length,
      approvedAmount: allClaims
        .filter((c) => c.status === "approved")
        .reduce((sum, c) => sum + (c.computedAmount ?? 0), 0),
    };
  }, [claims]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Briefcase className="h-8 w-8 text-primary" />
            Sales Claims
          </h1>
          <p className="text-muted-foreground mt-1">
            Read-only list of your sales-commission claims. File new entries
            from the unified Pipeline; claims are auto-derived from each
            sales entry.
          </p>
        </div>
        {/* Plan 2: filing happens in the Pipeline (Sales tab). This CTA is a
            cross-domain link within the Sales domain only — never to
            /portal/claims, /portal/commissions/*, or /portal/renovation-claims. */}
        <Link to="/portal/pipeline?tab=sales">
          <Button variant="gold">
            <PlusCircle className="h-4 w-4" /> New Sales Entry
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard
          glowColor="blue"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                My claims
              </p>
              <p className="text-3xl font-bold text-foreground">{stats.total}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClipboardList className="h-3 w-3" />
                <span>across all statuses</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-blue-500/10">
              <ClipboardList className="h-6 w-6 text-blue-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Awaiting review
              </p>
              <p className="text-3xl font-bold text-foreground">
                {stats.pending}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Receipt className="h-3 w-3" />
                <span>submitted + pending</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Receipt className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Approved value
              </p>
              <p className="text-3xl font-bold text-foreground">
                {formatRM(stats.approvedAmount)}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3" />
                <span>{stats.approved} claims approved</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-emerald-500/10">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard
          glowColor="red"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Needs amendment
              </p>
              <p className="text-3xl font-bold text-foreground">
                {stats.needsAmend}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <TriangleAlert className="h-3 w-3" />
                <span>action required</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-rose-500/10">
              <TriangleAlert className="h-6 w-6 text-rose-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Filter bar */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5 flex-wrap">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  statusFilter === s
                    ? "bg-[var(--gold)]/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "all" ? "All" : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Claims table — read-only. Row-click Edit removed (Plan 2: no in-page
          edit; Pipeline is the single filing surface). */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Coins className="h-5 w-5 text-primary" />
            My Sales Claims
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-hidden">
          {claimsLoading ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground animate-pulse">
              Loading claims…
            </div>
          ) : claims.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground italic">
              No sales claims yet. File a sales entry from the Pipeline.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[var(--page-bg)] border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Sales Unit
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Commission
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Payment
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Submitted
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => {
                    const unit = units.find((u) => u.id === c.salesUnitId);
                    return (
                      <tr
                        key={c.id}
                        className="border-b border-border"
                      >
                        <td className="px-4 py-3.5 text-sm">
                          <div className="font-medium text-foreground font-mono">
                            {unit?.unitNumber ?? c.salesUnitId.slice(0, 8)}
                          </div>
                          {unit && (
                            <div className="text-xs text-muted-foreground">
                              {formatRM(unit.purchasePrice)} · {unit.purpose}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-sm">
                          {c.commissionType === "percent_of_purchase"
                            ? `${c.commissionValue ?? "?"}% of purchase`
                            : "Fixed amount"}
                        </td>
                        <td className="px-4 py-3.5 text-sm text-right font-medium">
                          {c.computedAmount != null
                            ? formatRM(c.computedAmount)
                            : "-"}
                        </td>
                        <td className="px-4 py-3.5 text-sm capitalize">
                          {c.paymentType}
                        </td>
                        <td className="px-4 py-3.5 text-sm">
                          {c.submittedAt.slice(0, 10)}
                        </td>
                        <td className="px-4 py-3.5 text-sm">
                          <Badge variant={STATUS_VARIANT[c.status]}>
                            {STATUS_LABEL[c.status]}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
