// Cross-sprint trends (Spec 3 §5/§7) — REPLACES Spec 1's velocity chart.
// Three series across the last N closed sprints, all from the close-snapshot
// columns: velocity (completed, bar), carryover (carried, bar) and completion
// rate (%, line on a right axis). Mirrors the commission-dashboard inline
// ResponsiveContainer/ComposedChart pattern. Source = GET /sprints/trends.
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSprintTrends } from "@/api/tasks";

export function SprintTrendsChart({ window }: { window?: number } = {}) {
  const trendsQuery = useSprintTrends(window);

  const data = useMemo(
    () =>
      (trendsQuery.data?.data ?? []).map((p) => ({
        name: p.name ?? `Sprint ${p.seq}`,
        completed: p.completed,
        carried: p.carried,
        completionRate: p.completionRate,
      })),
    [trendsQuery.data],
  );

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold">Sprint trends</CardTitle>
        <p className="text-xs text-muted-foreground">
          Velocity, carryover & completion rate across recent sprints.
        </p>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <div data-testid="sprint-trends-chart">
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={50}
                />
                <YAxis
                  yAxisId="count"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  width={32}
                  allowDecimals={false}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  width={40}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--foreground)" }}
                  formatter={(value, name) =>
                    name === "Completion rate"
                      ? [`${Number(value)}%`, name]
                      : [`${Number(value)}`, name]
                  }
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  yAxisId="count"
                  dataKey="completed"
                  name="Completed"
                  fill="var(--gold)"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  yAxisId="count"
                  dataKey="carried"
                  name="Carried"
                  fill="var(--muted-foreground)"
                  radius={[4, 4, 0, 0]}
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="completionRate"
                  name="Completion rate"
                  stroke="#10B981"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            No completed sprints yet
          </div>
        )}
      </CardContent>
    </Card>
  );
}
