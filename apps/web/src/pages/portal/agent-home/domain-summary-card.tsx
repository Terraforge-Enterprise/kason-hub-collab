import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Button } from "@/components/ui/button";

export interface DomainSummaryCardProps {
  title: string;
  icon: LucideIcon;
  glowColor: "gold" | "blue" | "green" | "orange";
  statusCounts: Record<string, number> | null;
  primaryMetric?: { label: string; value: string };
  deepLink: { label: string; href: string };
}

// Static class maps so Tailwind JIT can scan them.
const ICON_BG: Record<DomainSummaryCardProps["glowColor"], string> = {
  gold:   "bg-amber-500/10",
  blue:   "bg-blue-500/10",
  green:  "bg-green-500/10",
  orange: "bg-orange-500/10",
};

const ICON_FG: Record<DomainSummaryCardProps["glowColor"], string> = {
  gold:   "text-amber-600",
  blue:   "text-blue-600",
  green:  "text-green-600",
  orange: "text-orange-600",
};

export function DomainSummaryCard({
  title, icon: Icon, glowColor, statusCounts, primaryMetric, deepLink,
}: DomainSummaryCardProps) {
  return (
    <GlowCard glowColor={glowColor} className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <div className={`p-2 rounded-lg ${ICON_BG[glowColor]}`}>
          <Icon className={`h-5 w-5 ${ICON_FG[glowColor]}`} />
        </div>
      </div>

      {statusCounts === null ? (
        <p className="text-xs text-muted-foreground">Couldn't load — try refreshing.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between rounded-md bg-background/40 px-2 py-1">
              <dt className="text-muted-foreground capitalize">{status.replace(/_/g, " ")}</dt>
              <dd className="font-semibold">{count}</dd>
            </div>
          ))}
        </dl>
      )}

      {primaryMetric && statusCounts !== null && (
        <div className="flex items-baseline justify-between border-t border-border/50 pt-3">
          <span className="text-xs text-muted-foreground">{primaryMetric.label}</span>
          <span className="text-lg font-bold">{primaryMetric.value}</span>
        </div>
      )}

      <Link to={deepLink.href} className="self-start">
        <Button variant="ghost" size="sm">{deepLink.label}</Button>
      </Link>
    </GlowCard>
  );
}
