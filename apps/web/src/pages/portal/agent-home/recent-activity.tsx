import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { AgentHomeFeedRow } from "@/api/portal-agent-home";

export function RecentActivity({ rows }: { rows: AgentHomeFeedRow[] }) {
  // Defensive client-side sort: server already sorts in production, but the
  // widget is robust to unsorted input so it can be reused by tests / callers
  // that haven't sorted yet.
  const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-2"><CardTitle className="text-lg">Recent activity</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {sorted.map((r) => (
              <li key={`${r.domain}:${r.id}`} className="py-2.5">
                <Link to={r.href} className="flex items-center justify-between text-sm hover:bg-accent rounded-md px-2 py-1 -mx-2">
                  <span>{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.updatedAt.slice(0, 10)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
