/**
 * Analytics charts for the Unit Analytics page (Spec 2 §4.4).
 * Uses recharts (already a dep — same pattern as donut-chart.tsx).
 * Lightweight bar list for top-categories + a bar chart for monthly volume.
 * No new chart dependency.
 */
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { CategoryLensRow, TrendPoint } from "@kason/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, TrendingUp } from "lucide-react";

// ── Color palette for categories (cycles if more than 8) ──────────────────────
const CATEGORY_COLORS = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#f97316", // orange
  "#14b8a6", // teal
];

// ── Top-categories bar list ───────────────────────────────────────────────────

interface CategoryBarsProps {
  rows: CategoryLensRow[];
}

export function CategoryBars({ rows }: CategoryBarsProps) {
  const sorted = [...rows].sort((a, b) => b.total - a.total).slice(0, 8);
  const max = sorted[0]?.total ?? 1;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Top Categories
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No category data</p>
        ) : (
          sorted.map((row, i) => {
            const pct = max > 0 ? (row.total / max) * 100 : 0;
            const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
            return (
              <div key={row.canonical} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-foreground font-medium truncate max-w-[70%]">
                    {row.canonical}
                  </span>
                  <span className="text-muted-foreground shrink-0 ml-2 tabular-nums">
                    {row.total}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-2 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                    aria-label={`${row.canonical}: ${row.total} tickets`}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ── Created-vs-Resolved trend chart ──────────────────────────────────────────

const CREATED_COLOR = "#f59e0b"; // amber
const RESOLVED_COLOR = "#10b981"; // emerald

interface CreatedVsResolvedProps {
  points: TrendPoint[];
}

export function CreatedVsResolvedChart({ points }: CreatedVsResolvedProps) {
  const data = points.map((p) => ({
    month: p.month,
    created: p.created,
    resolved: p.resolved,
    label: formatMonth(p.month),
  }));

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          Created vs Resolved
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No trend data</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                cursor={{ fill: "rgba(255,255,255,0.05)" }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="created" name="Created" fill={CREATED_COLOR} radius={[4, 4, 0, 0]} />
              <Bar dataKey="resolved" name="Resolved" fill={RESOLVED_COLOR} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMonth(ym: string): string {
  // "YYYY-MM" or "YYYY-MM-DD..." → "Jan 25"
  const parts = ym.slice(0, 7).split("-");
  if (parts.length < 2) return ym;
  const [year, mon] = parts;
  const date = new Date(Number(year), Number(mon) - 1, 1);
  return date.toLocaleDateString("en-MY", { month: "short", year: "2-digit" });
}
