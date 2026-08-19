/**
 * Admin sales unit detail page (route: `/sales/units/:id`).
 *
 * Mirrors the inventory detail-page pattern: breadcrumb, hero card,
 * GlowCard stat grid for layout/financials, plus an inline copy of the
 * SalesUnitDrawer body for full-fidelity editing without a sheet.
 *
 * Reuses `<SalesUnitDrawer>` so we keep one source of truth for the
 * editing UX. The page version supplies a wider container.
 */
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Car,
  Wallet,
  Building2,
  Sparkles,
} from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import {
  getSalesUnit,
  listSalesProjects,
} from "@/api/sales";
import { SalesUnitDrawer } from "./sales-unit-drawer";

function formatRM(value: number | null | undefined): string {
  if (value == null) return "—";
  return `RM ${value.toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function isManagerPlus(role: string | undefined): boolean {
  return role === "manager" || role === "admin";
}

export default function SalesUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canEdit = isManagerPlus(user?.role);

  const unitQuery = useQuery({
    queryKey: ["sales", "unit", id],
    queryFn: () => getSalesUnit(id!),
    enabled: !!id,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => listSalesProjects(),
  });

  if (unitQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 w-64 bg-muted rounded" />
        <div className="h-32 bg-muted rounded-xl" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 bg-muted rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (unitQuery.isError) {
    const notFound =
      unitQuery.error instanceof ApiError && unitQuery.error.status === 404;
    return (
      <div className="space-y-4">
        <Link
          to="/sales/pipeline"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to sales pipeline
        </Link>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {notFound
                ? "This sales unit no longer exists."
                : "Failed to load sales unit details. Please try again."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const unit = unitQuery.data?.data;
  if (!unit) return null;
  const project = projectsQuery.data?.data?.find((p) => p.id === unit.projectId);
  const projectName = project?.name ?? "Unknown project";

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="text-xs text-muted-foreground">
        <Link to="/sales/pipeline" className="hover:text-foreground">
          Sales pipeline
        </Link>
        <span className="mx-2">›</span>
        <span>{projectName}</span>
        <span className="mx-2">›</span>
        <span className="text-foreground font-medium">{unit.unitNumber}</span>
      </nav>

      {/* Hero */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl md:text-3xl font-bold text-foreground font-mono">
                {unit.unitNumber}
              </h1>
              <Badge variant={unit.purpose === "rent" ? "sky" : "outline"}>
                {unit.purpose === "rent" ? "rent" : "own stay"}
              </Badge>
              {unit.sourcingApproved ? (
                <Badge variant="emerald">Sourcing approved</Badge>
              ) : (
                <Badge variant="amber">Sourcing pending</Badge>
              )}
              {unit.promotedUnitId && (
                <Badge variant="emerald">Promoted</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {projectName} · sold {unit.salesDate.slice(0, 10)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          glowColor="blue"
          icon={<BedDouble className="h-6 w-6 text-sky-400" />}
          iconBg="bg-sky-500/10"
          label="Bedrooms"
          value={unit.bedrooms === -1 ? "Studio" : String(unit.bedrooms)}
          detail={unit.bedrooms === 1 ? "room" : "rooms"}
        />
        <Stat
          glowColor="green"
          icon={<Bath className="h-6 w-6 text-emerald-400" />}
          iconBg="bg-emerald-500/10"
          label="Bathrooms"
          value={String(unit.bathrooms)}
          detail={unit.bathrooms === 1 ? "full bath" : "full baths"}
        />
        <Stat
          glowColor="purple"
          icon={<Car className="h-6 w-6 text-violet-400" />}
          iconBg="bg-violet-500/10"
          label="Parking"
          value={String(unit.parkingLots)}
          detail={unit.parkingLots === 1 ? "lot" : "lots"}
        />
        <Stat
          glowColor="gold"
          icon={<Wallet className="h-6 w-6 text-amber-400" />}
          iconBg="bg-amber-500/10"
          label="Purchase price"
          value={formatRM(unit.purchasePrice)}
          detail="developer"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetaRow
          icon={<Building2 className="h-4 w-4" />}
          label="Project"
          value={
            <span className="font-medium">
              {projectName}
              {project?.developer ? ` · ${project.developer}` : ""}
            </span>
          }
        />
        <MetaRow
          icon={<Wallet className="h-4 w-4" />}
          label="Expected rental"
          value={
            <span className="font-medium tabular-nums">
              {unit.expectedRental != null
                ? `${formatRM(unit.expectedRental)} / mo`
                : "—"}
            </span>
          }
        />
        <MetaRow
          icon={<Sparkles className="h-4 w-4" />}
          label="Source"
          value={<span className="capitalize">{unit.sourceFlag.replace("_", " ").toLowerCase()}</span>}
        />
      </div>

      {/* Full editor body — reuse the drawer body inline */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <SalesUnitDrawer
            unitId={unit.id}
            canEdit={canEdit}
            projectName={() => projectName}
            onClose={() => {
              /* no-op on the page route */
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  glowColor,
  icon,
  iconBg,
  label,
  value,
  detail,
}: {
  glowColor: "blue" | "green" | "purple" | "gold" | "orange" | "red";
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <GlowCard
      glowColor={glowColor}
      className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
            {label}
          </p>
          <p className="text-2xl md:text-3xl font-bold text-foreground tabular-nums truncate">
            {value}
          </p>
          {detail && (
            <p className="text-xs text-muted-foreground truncate">{detail}</p>
          )}
        </div>
        <div className={`p-3 rounded-xl ${iconBg} shrink-0`}>{icon}</div>
      </div>
    </GlowCard>
  );
}

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        {icon}
        {label}
      </div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}
