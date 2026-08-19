import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Banknote, AlertTriangle, CalendarClock } from "lucide-react";
import { formatRM, formatDateMY } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Button } from "@/components/ui/button";
import { useDashboard, usePortalCharges, isOverdueCharge } from "./use-billing-data";
import { OverviewTab } from "./overview-tab";
import { InvoicesTab } from "./invoices-tab";
import { PaymentsTab } from "./payments-tab";

type BillingTab = "overview" | "invoices" | "payments";

// Statements is deliberately NOT in this list (Global Constraints: "Statements
// tab HIDDEN (v1)"). The /portal/statement route stays registered but is
// dropped from this tab bar.
const TABS: { key: BillingTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "invoices", label: "Invoices & Charges" },
  { key: "payments", label: "Payments" },
];

export default function PortalBillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: BillingTab = rawTab === "invoices" || rawTab === "payments" ? rawTab : "overview";

  const { data: dashboardData, isLoading: dashboardLoading } = useDashboard();
  const { data: chargesData } = usePortalCharges(1);

  // The overdue TOTAL is server-side (`balance.overdueAmount`). It used to be
  // summed here from `usePortalCharges(1)` — page 1 of 20 — so a tenant with
  // more than 20 charges was shown an overdue figure short by everything on
  // page 2+, and the client-side predicate additionally required
  // status === "posted", silently dropping partially-paid rows that are still
  // overdue for their remainder. The page-1 list is still used to NAME the
  // first overdue charge, which is a label, not a figure.
  const charges = chargesData?.data ?? [];
  const overdueCharges = useMemo(() => charges.filter((c) => isOverdueCharge(c)), [charges]);

  function setTab(next: BillingTab) {
    setSearchParams({ tab: next }, { replace: true });
  }

  if (dashboardLoading) return <BillingSkeleton />;

  const d = dashboardData?.data;
  if (!d) return null;

  const nextCharge = d.upcomingCharges[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Banknote className="h-8 w-8 text-primary" />
          Billing
        </h1>
        <p className="text-muted-foreground mt-1">
          View what you owe, previous payments and monthly statements.
        </p>
      </div>

      {/* Header stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Current balance</p>
              <p className="text-3xl font-bold text-foreground">{formatRM(d.balance.netBalance)}</p>
              <Button variant="gold" size="sm" onClick={() => setTab("overview")}>
                Pay outstanding
              </Button>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Banknote className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard glowColor="red" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Overdue</p>
              <p className="text-3xl font-bold text-rose-600">{formatRM(d.balance.overdueAmount)}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <AlertTriangle className="h-3 w-3" />
                <span>
                  {d.balance.overdueCount === 0
                    ? "No overdue charges"
                    : overdueCharges[0]?.description || overdueCharges[0]?.chargeType || `${d.balance.overdueCount} charges past due`}
                </span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-red-500/10">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Next due</p>
              <p className="text-3xl font-bold text-foreground">
                {nextCharge ? formatDateMY(nextCharge.dueDate) : "All clear"}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                <span>{nextCharge ? formatRM(nextCharge.amount) : "No upcoming charges"}</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <CalendarClock className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Tab bar — deep-linked via ?tab=; Statements intentionally absent. */}
      <div role="tablist" aria-label="Billing sections" className="flex gap-6 border-b border-border/50">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={
                active
                  ? "pb-3 -mb-px text-sm font-semibold border-b-2 border-[var(--gold)] text-[var(--gold)]"
                  : "pb-3 -mb-px text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors"
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === "overview" && <OverviewTab balance={d.balance} />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "payments" && <PaymentsTab />}
    </div>
  );
}

function BillingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-64 bg-muted rounded" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="h-10 bg-muted rounded" />
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}
