import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Wallet, TrendingUp, Calendar, Clock, LayoutDashboard } from "lucide-react";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, getStatusTone } from "@/components/format";
import { DonutChart } from "@/components/donut-chart";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/* ── Types ──────────────────────────────────────────────────────────────────── */

type DashboardResponse = {
  data: {
    summary: { totalEarned: number; thisMonthEarned: number; thisYearEarned: number; submitted: number };
    statusBreakdown: { submitted: number; approved: number; paid: number };
    monthly: { month: string; total: number }[];
    yearly: { year: number; total: number }[];
  };
};

type ClaimItem = {
  id: string;
  claimNumber: string;
  status: string;
  totalNettPayout: number;
  submittedAt: string | null;
  createdAt: string;
};

type ClaimsResponse = {
  data: ClaimItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function monthLabel(key: string) {
  const [y, m] = key.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

/* ── Main Page ──────────────────────────────────────────────────────────────── */

export default function CommissionDashboardPage() {
  const [claimStatus, setClaimStatus] = useState("all");
  const [claimPage, setClaimPage] = useState(1);

  const { data: dashData, isLoading: dashLoading } = useQuery({
    queryKey: ["agent-commission-dashboard"],
    queryFn: () => portalApiFetch<DashboardResponse>("/commissions/dashboard"),
  });

  const claimParams = new URLSearchParams({ page: String(claimPage), limit: "10" });
  if (claimStatus !== "all") claimParams.set("status", claimStatus);

  const { data: claimsData, isLoading: claimsLoading } = useQuery({
    queryKey: ["agent-commission-claims", claimPage, claimStatus],
    queryFn: () => portalApiFetch<ClaimsResponse>(`/commissions/claims?${claimParams}`),
  });

  const d = dashData?.data;
  const claims = claimsData?.data ?? [];
  const pagination = claimsData?.pagination;

  // Chart data
  const barData = useMemo(
    () => (d?.monthly ?? []).map((m) => ({ name: monthLabel(m.month), value: m.total })),
    [d?.monthly],
  );

  const donutData = useMemo(() => {
    if (!d) return [];
    return [
      { name: "Submitted", value: d.statusBreakdown.submitted, color: "#f59e0b" },
      { name: "Approved", value: d.statusBreakdown.approved, color: "#0ea5e9" },
      { name: "Paid", value: d.statusBreakdown.paid, color: "#10b981" },
    ];
  }, [d]);

  if (dashLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-64 bg-muted rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 bg-muted rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 h-72 bg-muted rounded-xl" />
          <div className="h-72 bg-muted rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <LayoutDashboard className="h-8 w-8 text-primary" />
            Commission Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">Track your earnings and claims</p>
        </div>
        <Link to="/portal/claims/new">
          <Button variant="gold" size="lg">Submit New Claim</Button>
        </Link>
      </div>

      {/* ── Summary Cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total Earned (All Time)</p>
              <p className="text-3xl font-bold text-foreground">{d ? formatRM(d.summary.totalEarned) : "—"}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Wallet className="h-3 w-3" />
                <span>Lifetime earnings</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Wallet className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">This Month</p>
              <p className="text-3xl font-bold text-foreground">{d ? formatRM(d.summary.thisMonthEarned) : "—"}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>Current month</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-blue-500/10">
              <Calendar className="h-6 w-6 text-blue-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">This Year</p>
              <p className="text-3xl font-bold text-foreground">{d ? formatRM(d.summary.thisYearEarned) : "—"}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                <span>Year to date</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <TrendingUp className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Submitted Commission</p>
              <p className="text-3xl font-bold text-foreground">{d ? formatRM(d.summary.submitted) : "—"}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Awaiting approval</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <Clock className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* ── Charts Row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Monthly Bar Chart */}
        <Card className="lg:col-span-2 bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold">Monthly Commission</CardTitle>
          </CardHeader>
          <CardContent>
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={barData} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} interval={0} angle={-45} textAnchor="end" height={50} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} width={60} tickFormatter={(v: number) => `RM ${v.toLocaleString()}`} />
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                    formatter={(value) => [formatRM(Number(value)), "Commission"]}
                    labelStyle={{ color: "var(--foreground)" }}
                  />
                  <Bar dataKey="value" fill="var(--gold)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No data yet</div>
            )}
          </CardContent>
        </Card>

        {/* Status Donut Chart */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold">Claim Status Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart data={donutData} />
          </CardContent>
        </Card>
      </div>

      {/* ── Yearly Breakdown ───────────────────────────────────────────────── */}
      {d && d.yearly.length > 0 && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold">Yearly Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {d.yearly.map((y) => (
                <div key={y.year} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="text-xs text-muted-foreground">{y.year}</div>
                  <div className="text-sm font-bold text-foreground mt-1">{formatRM(y.total)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Claim History ──────────────────────────────────────────────────── */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Claim History</h2>
          <Link to="/portal/commissions/claims" className="text-xs text-[var(--gold)] hover:underline">View All</Link>
        </div>

        {/* Status filter pills */}
        <div className="flex gap-2 flex-wrap px-4 py-3 border-b border-border">
          {(["all", "draft", "submitted", "approved", "rejected", "paid"] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setClaimStatus(s); setClaimPage(1); }}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                claimStatus === s
                  ? "bg-[var(--gold)] text-[var(--gold-fg)]"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {claimsLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground animate-pulse">Loading...</div>
        ) : claims.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No claims found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Claim #</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Submitted</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Nett Payout</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent transition-colors">
                  <td className="px-4 py-2.5">
                    <Link to={`/portal/claims/${c.id}`} className="text-[var(--gold)] hover:underline">{c.claimNumber}</Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{(c.submittedAt ?? c.createdAt).slice(0, 10)}</td>
                  <td className="px-4 py-2.5 text-right text-foreground">{formatRM(c.totalNettPayout)}</td>
                  <td className="px-4 py-2.5"><ClaimStatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-xs text-muted-foreground">
            <span>Page {pagination.page} of {pagination.totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setClaimPage((p) => Math.max(1, p - 1))} disabled={claimPage <= 1}
                className="px-2.5 py-1 rounded border border-input disabled:opacity-30">Prev</button>
              <button onClick={() => setClaimPage((p) => p + 1)} disabled={claimPage >= pagination.totalPages}
                className="px-2.5 py-1 rounded border border-input disabled:opacity-30">Next</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────────── */

const toneBadgeClasses: Record<string, string> = {
  emerald: "bg-emerald-500/10 text-emerald-400",
  amber: "bg-amber-500/10 text-amber-400",
  rose: "bg-red-500/10 text-red-400",
  sky: "bg-sky-500/10 text-sky-400",
  slate: "bg-slate-500/10 text-slate-400",
};

function ClaimStatusBadge({ status }: { status: string }) {
  const tone = getStatusTone(status);
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${toneBadgeClasses[tone] ?? toneBadgeClasses.slate}`}>
      {status}
    </span>
  );
}
