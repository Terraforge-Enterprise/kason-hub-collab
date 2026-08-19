import { formatNumber } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import {
  Building2,
  CheckCircle2,
  Home,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";

type MetricsRowProps = {
  tenancyCount: number;
  ownerCount: number;
  tenantCount: number;
  propertyCount: number;
  unitCount: number;
  occupiedUnitCount: number;
  vacantUnitCount: number;
  occupancyRate: number;
};

export function MetricsRow({
  tenancyCount,
  ownerCount,
  tenantCount,
  propertyCount,
  unitCount,
  occupiedUnitCount,
  vacantUnitCount,
  occupancyRate,
}: MetricsRowProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <GlowCard
        glowColor="purple"
        className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
      >
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Active Tenancies
            </p>
            <p className="text-3xl font-bold text-foreground">
              {formatNumber(tenancyCount)}
            </p>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              <span>
                {formatNumber(ownerCount)} owners ·{" "}
                {formatNumber(tenantCount)} tenants
              </span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-purple-500/10">
            <ShieldCheck className="h-6 w-6 text-purple-600" />
          </div>
        </div>
      </GlowCard>

      <GlowCard
        glowColor="blue"
        className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
      >
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              Properties
            </p>
            <p className="text-3xl font-bold text-foreground">
              {formatNumber(propertyCount)}
            </p>
            <div className="flex items-center gap-1 text-xs text-green-600">
              <TrendingUp className="h-3 w-3" />
              <span>{formatNumber(unitCount)} total units</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-blue-500/10">
            <Building2 className="h-6 w-6 text-blue-600" />
          </div>
        </div>
      </GlowCard>

      <GlowCard
        glowColor="green"
        className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
      >
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Units</p>
            <p className="text-3xl font-bold text-foreground">
              {formatNumber(unitCount)}
            </p>
            <div className="flex items-center gap-1 text-xs text-green-600">
              <Home className="h-3 w-3" />
              <span>{formatNumber(occupiedUnitCount)} occupied</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-green-500/10">
            <Home className="h-6 w-6 text-green-600" />
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
              Occupancy
            </p>
            <p className="text-3xl font-bold text-foreground">
              {occupancyRate}%
            </p>
            <div className="flex items-center gap-1 text-xs text-orange-600">
              <TrendingUp className="h-3 w-3" />
              <span>{formatNumber(vacantUnitCount)} vacant</span>
            </div>
          </div>
          <div className="p-3 rounded-xl bg-orange-500/10">
            <CheckCircle2 className="h-6 w-6 text-orange-600" />
          </div>
        </div>
      </GlowCard>
    </div>
  );
}
