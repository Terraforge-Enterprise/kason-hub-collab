import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { AgentHomeFeedRow } from "@/api/portal-agent-home";

const DOMAIN_LABEL: Record<AgentHomeFeedRow["domain"], string> = {
  "pipeline":          "Sales Pipeline",
  "sales-claim":       "Sales Claim",
  "renovation-claim":  "Renovation Claim",
  "commission":        "Commission",
};

export function PendingActionFeed({ rows }: { rows: AgentHomeFeedRow[] }) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-2"><CardTitle className="text-lg">Pending action ({rows.length})</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> All caught up.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {rows.map((r) => (
              <li key={`${r.domain}:${r.id}`} className="py-2.5">
                <Link to={r.href} className="flex items-center justify-between text-sm hover:bg-accent rounded-md px-2 py-1 -mx-2">
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5 text-xs font-medium">{DOMAIN_LABEL[r.domain]}</span>
                    <span>{r.label}</span>
                  </span>
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
