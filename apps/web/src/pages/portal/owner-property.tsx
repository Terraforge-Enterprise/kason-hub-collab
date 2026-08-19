// Phase-2 Owner Billing (T8) — portal owner property view.
// Renders §3 of the owner-ledger spec: property name, address, units with
// tenancy + deposits, management-fee rate, and PIC.
// Owner-scoped: the API 404s if the caller doesn't hold the property → friendly
// empty state (no crash).

import { useParams, Link } from "react-router-dom";
import { useOwnerProperty, type OwnerPropertyView } from "@/api/portal-owner-ledger";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { Building2, ArrowLeft, MapPin, User, Settings2, Home, Shield } from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compose the split address fields into a single display string. */
function composeAddress(addr: OwnerPropertyView["address"]): string {
  const parts = [
    addr.addressLine1,
    addr.addressLine2,
    addr.postalCode ? `${addr.postalCode} ${addr.city ?? ""}`.trim() : addr.city,
    addr.state,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}

/** Format the management-fee config to a human-readable label. */
function feeLabel(cfg: NonNullable<OwnerPropertyView["managementFeeConfig"]>): string {
  const feeType = cfg.feeType === "percentage" ? "%" : "";
  const base = `${cfg.feeValue}${feeType}`;
  const cap = cfg.capAmount ? ` (cap ${formatRM(parseFloat(cfg.capAmount))})` : "";
  const sst = cfg.sstPercent && cfg.sstPercent !== "0" ? ` + ${cfg.sstPercent}% SST` : "";
  return `${base}${sst}${cap}`;
}

/** Map a deposit/occupancy status string to a Badge variant. */
function statusVariant(status: string): "emerald" | "amber" | "rose" | "sky" | "secondary" {
  const tone = getStatusTone(status);
  if (tone === "emerald") return "emerald";
  if (tone === "amber") return "amber";
  if (tone === "rose") return "rose";
  if (tone === "sky") return "sky";
  return "secondary";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function UnitCard({ unit }: { unit: OwnerPropertyView["units"][number] }) {
  const t = unit.currentTenancy;

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 backdrop-blur-sm overflow-hidden">
      {/* Unit header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/50 bg-background/20">
        <div className="flex items-center gap-2">
          <Home className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold text-foreground">{unit.unitCode}</span>
        </div>
        <Badge variant={statusVariant(unit.occupancyStatus)}>{unit.occupancyStatus}</Badge>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Tenancy details */}
        {t ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Tenancy</p>
            <p className="text-sm font-medium text-foreground">{t.tenantDisplayName}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                {formatDate(t.startDate)} — {t.endDate ? formatDate(t.endDate) : "ongoing"}
              </span>
              <span className="text-foreground font-medium">
                {formatRM(parseFloat(t.monthlyRentAmount))} / mo
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No active tenancy</p>
        )}

        {/* Deposits */}
        {unit.deposits.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Deposits</p>
            <div className="flex flex-wrap gap-2">
              {unit.deposits.map((dep) => (
                <div
                  key={dep.id}
                  className="flex items-center gap-1.5 rounded-md bg-background/60 border border-border/50 px-2 py-1 text-xs"
                >
                  <Shield className="h-3 w-3 text-muted-foreground" />
                  <span className="text-foreground capitalize">{dep.type.replace(/_/g, " ")}</span>
                  <span className="text-foreground font-medium">{formatRM(parseFloat(dep.amount))}</span>
                  <Badge variant={statusVariant(dep.status)} className="h-4 text-[10px] px-1">
                    {dep.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OwnerPropertyPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useOwnerProperty(id);

  const property = data?.data;

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Back link */}
      <div>
        <Link
          to="/portal/income-tax"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Financials
        </Link>
      </div>

      {isLoading && <PropertySkeleton />}

      {/* 404 / not-owned */}
      {isError && !isLoading && (
        <EmptyState
          icon={Building2}
          title="Property not found or not yours"
          description="This property does not exist or you do not have access to it. Please check the link or go back to your Financials page."
          actionLabel="Back to Financials"
          actionHref="/portal/income-tax"
        />
      )}

      {property && (
        <>
          {/* Property header */}
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
              <Building2 className="h-8 w-8 text-primary" />
              {property.name}
            </h1>
            {composeAddress(property.address) && (
              <p className="text-muted-foreground mt-1 flex items-center gap-1.5">
                <MapPin className="h-4 w-4 shrink-0" />
                {composeAddress(property.address)}
              </p>
            )}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Total Units</p>
                  <p className="text-3xl font-bold text-foreground">{property.units.length}</p>
                </div>
                <div className="p-3 rounded-xl bg-blue-500/10">
                  <Home className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Occupied Units</p>
                  <p className="text-3xl font-bold text-emerald-500">
                    {property.units.filter((u) => u.occupancyStatus === "occupied").length}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-green-500/10">
                  <Building2 className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">PIC (Manager)</p>
                  <p className="text-base font-semibold text-foreground truncate">
                    {property.managerId ?? "—"}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <User className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </GlowCard>
          </div>

          {/* Management fee */}
          {property.managementFeeConfig && (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Settings2 className="h-4 w-4 text-primary" />
                  Management Fee
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-foreground">{feeLabel(property.managementFeeConfig)}</p>
              </CardContent>
            </Card>
          )}

          {/* Units */}
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-bold flex items-center gap-2">
                <Home className="h-5 w-5 text-primary" />
                Units
              </CardTitle>
            </CardHeader>
            <CardContent>
              {property.units.length === 0 ? (
                <EmptyState
                  icon={Home}
                  title="No units found"
                  description="No units are recorded for this property yet."
                />
              ) : (
                <div className="space-y-3">
                  {property.units.map((unit) => (
                    <UnitCard key={unit.listingId} unit={unit} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PropertySkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-64 bg-muted rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 bg-muted rounded-2xl" />
        ))}
      </div>
      <div className="h-16 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
    </div>
  );
}
