import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Plus, Users, UserCheck, ShieldAlert, Briefcase } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { TenantTable } from "./tenants-table";
import { CreateTenantDialog } from "./tenants-action-dialogs";
import { PartiesAreaTabs } from "./parties-area-tabs";
import type { TenantListItem } from "./tenants-table";

export default function TenantsPage() {
  const [searchParams] = useSearchParams();
  const focusedPartyId = searchParams.get("partyId");
  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => apiFetch<{ data: TenantListItem[] }>("/parties/tenants"),
  });

  if (tenants.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <PartiesAreaTabs activeTab="tenants" />
        {/* Header band */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="h-7 w-48 rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-4 w-72 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          </div>
          <div className="h-9 w-32 rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
        {/* Metric strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-20 rounded-2xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
        {/* Table block */}
        <div className="h-96 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (tenants.isError) {
    return (
      <div className="space-y-6">
        <PartiesAreaTabs activeTab="tenants" />
        <p className="p-6 text-sm text-rose-600">
          Failed to load tenants. Please refresh.
        </p>
      </div>
    );
  }

  const tenantList = tenants.data!.data;
  const activeCount = tenantList.filter((t) => t.status === "active").length;
  const blacklistedCount = tenantList.filter((t) => t.isBlacklisted).length;
  const withOccupationCount = tenantList.filter((t) => t.occupation).length;

  const metrics = [
    {
      label: "Tenants",
      value: tenantList.length,
      glowColor: "gold" as const,
      icon: Users,
      iconClass: "text-amber-500 bg-amber-500/10",
    },
    {
      label: "Active",
      value: activeCount,
      glowColor: "green" as const,
      icon: UserCheck,
      iconClass: "text-green-600 bg-green-500/10",
    },
    {
      label: "Blacklisted",
      value: blacklistedCount,
      glowColor: "red" as const,
      icon: ShieldAlert,
      iconClass: "text-rose-600 bg-red-500/10",
    },
    {
      label: "With occupation",
      value: withOccupationCount,
      glowColor: "blue" as const,
      icon: Briefcase,
      iconClass: "text-blue-600 bg-blue-500/10",
    },
  ];

  return (
    <div className="space-y-6">
      <PartiesAreaTabs activeTab="tenants" />

      {/* Compact header band */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-foreground">Tenant registry</h1>
          <p className="text-sm text-muted-foreground">
            Identity, affordability metadata, and blacklist risk signals in one place.
          </p>
        </div>
        <CreateTenantDialog
          trigger={
            <Button variant="gold">
              <Plus className="size-4" /> New Tenant
            </Button>
          }
        />
      </div>

      {/* Slim metric strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {metrics.map((m) => {
          const Icon = m.icon;
          return (
            <GlowCard
              key={m.label}
              glowColor={m.glowColor}
              className="p-4 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{m.label}</p>
                  <p className="text-2xl font-bold text-foreground">{m.value}</p>
                </div>
                <div className={`p-2 rounded-lg ${m.iconClass}`}>
                  <Icon className="size-5" />
                </div>
              </div>
            </GlowCard>
          );
        })}
      </div>

      {/* Glass table card */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden py-0">
        <TenantTable tenants={tenantList} focusedPartyId={focusedPartyId} />
      </Card>
    </div>
  );
}
