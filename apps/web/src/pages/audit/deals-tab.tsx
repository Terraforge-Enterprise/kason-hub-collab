import { useState } from "react";
import { ClipboardCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useDealAudit } from "@/hooks/use-deal-audit";
import type { DealAuditRow } from "@kason/shared";
import { PageHeader } from "@/components/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { formatDate, formatRM } from "@/components/format";
import { humanizeClaimType } from "@/lib/commission-labels";

/**
 * Deal Audit page — read-only, Manager+ view.
 *
 * Groups claims by (property + unit + room + move-in + tenant) so admins can
 * verify each deal's 100% allocation: tenant-side total + listing-side total
 * should sum to <= 100% of the monthly rental. Any TA shortfall applied is
 * shown inline, as is the company residual (unallocated percentage).
 *
 * Backend endpoint: GET /api/commissions/deal-audit (CR-6).
 * Route mount handled in CR-13.
 */
export default function DealAuditPage() {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const { data, isLoading, isError } = useDealAudit(page, pageSize);

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
        <div className="h-48 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
        <div className="h-48 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load deal audit. Please refresh.
      </p>
    );
  }

  const flaggedCount = data.data.filter((r) => Number(r.combinedTotal) > 100.0001).length;
  const shortfallCount = data.data.filter((r) => Number(r.totalShortfall) > 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deal Audit"
        description="Claims grouped by (property + unit + room + move-in + tenant). Review each deal's tenant-side total, listing-side total, company residual, and any TA shortfall to verify the 100% allocation."
        metrics={[
          { label: "Deals on page", value: String(data.data.length), hint: `Page ${data.pageInfo.page} of ${Math.max(1, Math.ceil(data.pageInfo.totalCount / data.pageInfo.pageSize))}` },
          { label: "Total Deals", value: String(data.pageInfo.totalCount), hint: "All deals on record" },
          { label: "Over 100%", value: String(flaggedCount), hint: flaggedCount > 0 ? "Review allocation immediately" : "All deals within allocation" },
          { label: "TA Shortfall", value: String(shortfallCount), hint: shortfallCount > 0 ? "Deals with TA shortfall applied" : "No shortfalls on page" },
        ]}
      />

      {data.data.length === 0 ? (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-6">
            <EmptyState
              icon={ClipboardCheck}
              title="No deals yet"
              description="Once agents submit and approve claims, grouped deals will appear here for audit."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.data.map((row) => (
            <DealAuditCard
              key={`${row.propertyId}-${row.unitCode}-${row.moveInDate}-${row.tenantName}`}
              row={row}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={data.pageInfo.totalCount}
        onChange={setPage}
      />
    </div>
  );
}

function DealAuditCard({ row }: { row: DealAuditRow }) {
  const combined = Number(row.combinedTotal);
  const over100 = combined > 100.0001;
  const shortfall = Number(row.totalShortfall);

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold flex flex-wrap items-center gap-2">
              <span className="text-foreground">{row.condoName}</span>
              <span className="text-muted-foreground">&middot;</span>
              <span className="font-mono text-foreground">{row.unitCode}</span>
              <span className="text-muted-foreground">&middot;</span>
              <span className="text-foreground">{row.roomType}</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Tenant:{" "}
              <span className="font-medium text-foreground">{row.tenantName}</span>
              <span className="mx-1.5">&middot;</span>
              Move-in {formatDate(row.moveInDate)}
              <span className="mx-1.5">&middot;</span>
              Sales {formatDate(row.salesDate)}
            </p>
          </div>
          <div className="shrink-0">
            {over100 ? (
              <Badge variant="rose" className="h-auto px-3 py-1 text-sm">
                <AlertTriangle className="h-3 w-3" />
                Total {row.combinedTotal}% &gt; 100
              </Badge>
            ) : (
              <Badge variant="emerald" className="h-auto px-3 py-1 text-sm">
                <CheckCircle2 className="h-3 w-3" />
                Total {row.combinedTotal}%
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Per-side allocation summary */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border/50 bg-background/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tenant side
            </p>
            <p className="mt-1 text-2xl font-bold text-foreground">{row.tenantSideTotal}%</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-background/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Listing side
            </p>
            <p className="mt-1 text-2xl font-bold text-foreground">{row.listingSideTotal}%</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-background/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Company residual
            </p>
            <p className="mt-1 text-2xl font-bold text-foreground">{row.companyResidual}%</p>
          </div>
        </div>

        {/* Shortfall alert — only when applied */}
        {shortfall > 0 && (
          <Callout variant="warning" title={`TA Shortfall applied: ${formatRM(shortfall)}`}>
            This deal fell below the company minimum for its TA tier; the shortfall has been deducted from agent payouts.
          </Callout>
        )}

        {/* Per-claim breakdown */}
        <div className="overflow-x-auto rounded-lg border border-border/50">
          <table className="w-full text-sm" style={{ minWidth: 720 }}>
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Claim #</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Agent</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Side</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Tier %</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Comm %</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Effective %</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Nett Payout</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest font-semibold text-muted-foreground whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody>
              {row.claims.map((cl) => (
                <tr key={cl.claimId} className="border-b border-border last:border-0 transition hover:bg-muted/20">
                  <td className="px-3 py-2.5 font-mono text-foreground whitespace-nowrap">{cl.claimNumber}</td>
                  <td className="px-3 py-2.5 text-foreground">{cl.agentName}</td>
                  <td className="px-3 py-2.5">
                    <Badge variant="outline" className="h-auto py-0.5">
                      {humanizeClaimType(cl.claimType)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground whitespace-nowrap">{cl.agentTierPercentage}%</td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground whitespace-nowrap">{cl.commissionPercentage}%</td>
                  <td className="px-3 py-2.5 text-right text-foreground whitespace-nowrap">{cl.effectivePercentage}%</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-foreground whitespace-nowrap">{formatRM(Number(cl.nettPayout))}</td>
                  <td className="px-3 py-2.5 text-muted-foreground capitalize whitespace-nowrap">{cl.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3 text-sm shadow-sm sm:flex-row">
      <p className="text-muted-foreground">
        Page <span className="font-semibold text-foreground">{page}</span> of{" "}
        <span className="font-semibold text-foreground">{totalPages}</span>
        <span className="mx-1.5">&middot;</span>
        <span className="font-semibold text-foreground">{total}</span>{" "}
        {total === 1 ? "deal" : "deals"}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
