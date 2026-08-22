import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiFetch } from "@/lib/api-client";
import { formatNumber, formatMoney } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { LoadFailed } from "@/components/load-failed";
import {
  ArrowUpRight,
  Building2,
  CreditCard,
  FileText,
  ShieldCheck,
  Users,
  Wrench,
  MapPin,
  Calendar,
  Clock,
  Loader2,
} from "lucide-react";
import { MetricsRow } from "./metrics-row";
import { RecentActivity } from "./recent-activity";
import { QuickActions } from "./quick-actions";
import { PerformanceCharts } from "./performance-charts";

interface DashboardMetrics {
  propertyCount: number;
  unitCount: number;
  occupiedUnitCount: number;
  vacantUnitCount: number;
  ownerCount: number;
  tenantCount: number;
  tenancyCount: number;
  chargeCount: number;
  postedChargeCount: number;
  paymentCount: number;
  activeRecurringCount: number;
  occupancyRate: number;
  vacancyRate: number;
  draftChargeCount: number;
}

interface DashboardFinance {
  totalOutstanding: number;
  totalPaidAmt: number;
  totalUnpaidAmt: number;
  comingDueAmt: number;
  overdueAmt: number;
}

interface DashboardCounts {
  propertyCount: number;
  unitCount: number;
  occupiedUnitCount: number;
  vacantUnitCount: number;
  ownerCount: number;
  tenantCount: number;
  tenancyCount: number;
  chargeCount: number;
  postedChargeCount: number;
  paymentCount: number;
  activeRecurringCount: number;
  expiringTenancies: number;
  pendingCharges: number;
  pendingChargeAmount: number;
  thisMonthPayments: number;
}

interface DashboardStats {
  orgName: string;
  metrics: DashboardMetrics;
  finance: DashboardFinance;
  counts: DashboardCounts;
  recent: {
    tenancies: unknown[];
    overdueCharges: unknown[];
    payments: unknown[];
    notifications: unknown[];
  };
}

export default function DashboardPage() {
  const { data, isPending, isError, refetch, isFetching, failureCount } = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: () => apiFetch<{ data: DashboardStats }>("/dashboard/stats"),
  });

  // While the first load is in flight (incl. cold-start retries) show the
  // skeleton; once we've failed at least once, surface a gentle "waking up"
  // note so a slow cold start reads as progress, not a freeze.
  if (isPending) return <DashboardSkeleton warming={failureCount > 0} />;

  // Only reached after retries are exhausted (see main.tsx retry policy) — a
  // genuine, sustained failure. Keep the page identity and offer a retry path
  // instead of a dead-end error string.
  if (isError || !data) {
    return (
      <div className="space-y-6">
        <DashboardGreetingHeader />
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="pt-6">
            <LoadFailed
              resource="your dashboard"
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const stats = data.data;
  const { metrics, finance, counts } = stats;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const currentMonth = new Date().toLocaleString("en-MY", { month: "short", year: "numeric" });

  // Product UI uses the legal company's correct display name. Do not surface
  // stale Organization.name values from older seeded databases here.
  const orgName = "KAEN Properties Management Sdn Bhd";
  const {
    propertyCount,
    unitCount,
    occupiedUnitCount,
    vacantUnitCount,
    ownerCount,
    tenantCount,
    tenancyCount,
    chargeCount,
    paymentCount,
    activeRecurringCount,
    occupancyRate,
    vacancyRate,
    draftChargeCount,
  } = metrics;

  const { totalOutstanding, totalPaidAmt, totalUnpaidAmt, comingDueAmt, overdueAmt } = finance;
  const expiringTenancies = counts.expiringTenancies;

  /* ── empty state ──────────────────────────────────── */
  if (propertyCount === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Building2 className="h-8 w-8 text-primary" />
            {greeting}
          </h1>
          <p className="text-muted-foreground mt-1">
            Real-time portfolio overview —{" "}
            <span className="gold-text font-semibold">{orgName}</span>
          </p>
        </div>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="pt-6">
            <EmptyState
              icon={Building2}
              title="Welcome to KAEN Properties"
              description="Get started by adding your first property, then add owners, tenants, and start billing."
              actionLabel="Create Property"
              actionHref="/inventory"
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ── main dashboard ───────────────────────────────── */
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Building2 className="h-8 w-8 text-primary" />
            {greeting}
          </h1>
          <p className="text-muted-foreground mt-1">
            Real-time portfolio overview —{" "}
            <span className="gold-text font-semibold">{orgName}</span>
          </p>
        </div>
      </div>

      {/* ── Row 1: Key Metrics — 4 GlowCards ─────────── */}
      <MetricsRow
        tenancyCount={tenancyCount}
        ownerCount={ownerCount}
        tenantCount={tenantCount}
        propertyCount={propertyCount}
        unitCount={unitCount}
        occupiedUnitCount={occupiedUnitCount}
        vacantUnitCount={vacantUnitCount}
        occupancyRate={occupancyRate}
      />

      {/* ── Row 2: Portfolio Summary + My Rentable Space ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              Portfolio Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">
                  Total Outstanding
                </p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatMoney(totalOutstanding)}
                </p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">
                  Recurring Charges
                </p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatNumber(activeRecurringCount)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              My Rentable Space
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatNumber(unitCount)}
                </p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">Vacant</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatNumber(vacantUnitCount)}
                  <span className="ml-1 text-sm font-normal text-rose-500">
                    {vacancyRate}%
                  </span>
                </p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">Occupied</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  {formatNumber(occupiedUnitCount)}
                  <span className="ml-1 text-sm font-normal text-emerald-500">
                    {occupancyRate}%
                  </span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 3: Tenancy Expiry + Rental Collection ──── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Calendar className="h-5 w-5 text-primary" />
              Tenancy Expiry Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">Expiring (next 60 days)</p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {expiringTenancies}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {tenancyCount > 0
                    ? `${((expiringTenancies / tenancyCount) * 100).toFixed(2)}%`
                    : "0%"}{" "}
                  of active tenancies
                </span>
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Rental Collection
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">Coming Due</p>
                <p className="mt-1 text-2xl font-bold text-foreground">
                  <span className="text-sm font-normal text-muted-foreground">RM</span>{" "}
                  {comingDueAmt.toLocaleString("en-MY", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <p className="text-xs text-muted-foreground">Overdue</p>
                <p className="mt-1 text-2xl font-bold text-rose-600">
                  <span className="text-sm font-normal text-muted-foreground">RM</span>{" "}
                  {overdueAmt.toLocaleString("en-MY", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 4: Charts ────────────────────────────── */}
      <PerformanceCharts
        totalPaidAmt={totalPaidAmt}
        totalUnpaidAmt={totalUnpaidAmt}
        comingDueAmt={comingDueAmt}
        overdueAmt={overdueAmt}
        currentMonth={currentMonth}
      />

      {/* ── Row 5: Needs Attention + Quick Actions ───── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentActivity
          vacantUnitCount={vacantUnitCount}
          draftChargeCount={draftChargeCount}
          paymentCount={paymentCount}
        />

        <QuickActions draftChargeCount={draftChargeCount} />
      </div>

      {/* ── Row 6: Modules ───────────────────────────── */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            Modules
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "Inventory",
                href: "/inventory",
                metric: `${formatNumber(propertyCount)} properties`,
                icon: Building2,
              },
              {
                title: "Parties",
                href: "/parties/tenants",
                metric: `${formatNumber(ownerCount + tenantCount)} contacts`,
                icon: Users,
              },
              {
                title: "Tenancies",
                href: "/tenancy/tenancies",
                metric: `${formatNumber(tenancyCount)} active`,
                icon: ShieldCheck,
              },
              {
                title: "Charges",
                href: "/billing/charges",
                metric: `${formatNumber(chargeCount)} records`,
                icon: FileText,
              },
              {
                title: "Payments",
                href: "/billing/payments",
                metric: `${formatNumber(paymentCount)} records`,
                icon: CreditCard,
              },
              {
                title: "Maintenance",
                href: "#",
                metric: "Coming soon",
                icon: Wrench,
              },
            ].map((item) => (
              <Link
                key={item.title}
                to={item.href}
                className="group flex items-start gap-3 rounded-lg border border-border/50 bg-background/40 p-4 backdrop-blur-sm transition-all duration-300 hover:border-border/80 hover:bg-background/60 hover:shadow-md"
              >
                <div className="rounded-lg bg-muted p-2.5">
                  <item.icon className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                      {item.title}
                    </p>
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.metric}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Page-identity header shown during loading/error, before `data` exists. */
function DashboardGreetingHeader() {
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return (
    <div>
      <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
        <Building2 className="h-8 w-8 text-primary" />
        {greeting}
      </h1>
      <p className="text-muted-foreground mt-1">Real-time portfolio overview</p>
    </div>
  );
}

function DashboardSkeleton({ warming = false }: { warming?: boolean }) {
  return (
    <div className="space-y-6">
      {warming && (
        // Transient loading status (role="status"), NOT a Callout alert — this
        // is live "still connecting" feedback with a spinner, shown only after
        // the first attempt has failed and we're into cold-start retries.
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>
            Waking up the server — this can take a few seconds after a period of
            inactivity.
          </span>
        </div>
      )}
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-64 bg-muted rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 bg-muted rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-48 bg-muted rounded-xl" />
          <div className="h-48 bg-muted rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-48 bg-muted rounded-xl" />
          <div className="h-48 bg-muted rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-72 bg-muted rounded-xl" />
          <div className="h-72 bg-muted rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-48 bg-muted rounded-xl" />
          <div className="h-48 bg-muted rounded-xl" />
        </div>
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    </div>
  );
}
