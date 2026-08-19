import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, formatDateMY } from "@/components/format";
import { cn } from "@/lib/utils";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { PortalDashboardResponse } from "@kason/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  Clock,
  FileText,
  Home,
  Bell,
  XCircle,
} from "lucide-react";

// A lease inside this window is worth surfacing as an action item — long enough
// that renewing or giving notice is still comfortable, short enough that the row
// is not permanently on screen.
const LEASE_ENDING_SOON_DAYS = 60;

// One row of "Needs your attention" — the section that replaced Home's merged
// charge+payment feed. That feed was a truncated copy of the Billing tab: the
// API caps `upcomingCharges` and `recentPayments` at 5 each, so a tenant with 6
// charges and 1 payment saw 6 of their 7 rows with nothing on screen saying so,
// while the Balance headline above it (an un-capped aggregate) stayed correct.
//
// Home no longer renders a ledger. Billing owns the complete, paginated,
// filterable lists; this section owns only what is UNRESOLVED — every figure
// comes from a server-side aggregate, and the two payment lists are capped
// server-side (ATTENTION_ROW_CAP) because "exception" is not a bound: refused
// slips accumulate forever. The cap is the difference from the old feed only
// because `hasMoreUnresolvedPayments` makes it VISIBLE — never truncate here
// without saying so.
type AttentionTone = "danger" | "warning";

// ONE source of truth per tone. `tone` and `badgeVariant` were separate fields
// that had to agree in every branch — the repo's lock-step-drift shape — and
// they had already drifted: an EXPIRED lease carried tone "warning" (amber
// icon) next to a rose "Expired" badge. A Record keyed on the union makes the
// pairing unrepresentable-if-wrong and adding a tone a compile error, not a
// silent mismatch.
const ATTENTION_TONE: Record<AttentionTone, { iconClass: string; badge: "rose" | "amber" }> = {
  danger: { iconClass: "text-rose-600", badge: "rose" },
  warning: { iconClass: "text-amber-600", badge: "amber" },
};

type AttentionItem = {
  id: string;
  tone: AttentionTone;
  icon: typeof AlertTriangle;
  title: string;
  detail: string;
  badge: string;
  to: string;
};

function buildAttentionItems(d: PortalDashboardResponse, today: Date): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (d.balance.overdueAmount > 0) {
    items.push({
      id: "overdue",
      tone: "danger",
      icon: AlertTriangle,
      title: `${formatRM(d.balance.overdueAmount)} overdue`,
      // "unpaid charge(s)" here vs "charge(s) past due" on the Overdue GlowCard
      // above — the two must not render identical text, or RTL's exact-match
      // getByText collides on two nodes.
      detail: `${d.balance.overdueCount} unpaid charge${d.balance.overdueCount === 1 ? "" : "s"} past due`,
      badge: "Pay now",
      to: "/portal/billing?tab=overview",
    });
  }

  // Awaiting the office. Home used to render these with a hardcoded emerald
  // "Paid" badge — the tenant's own unverified claim shown back to them as
  // money received.
  for (const p of d.attention.pendingVerificationPayments) {
    items.push({
      id: `pending-${p.id}`,
      tone: "warning",
      icon: Clock,
      title: `Transfer slip ${formatRM(p.amount)}`,
      detail: `We're verifying this — submitted ${formatDateMY(p.submittedAt)}`,
      badge: "Verifying",
      to: "/portal/billing?tab=payments",
    });
  }

  for (const p of d.attention.rejectedPayments) {
    items.push({
      id: `rejected-${p.id}`,
      tone: "danger",
      icon: XCircle,
      title: `Payment ${formatRM(p.amount)} wasn't accepted`,
      // The reason is the actionable half — without it the tenant cannot fix
      // whatever we are asking them to fix.
      detail: p.rejectionReason || "Please contact the office or submit a new slip.",
      badge: "Not accepted",
      to: "/portal/billing?tab=payments",
    });
  }

  // The server capped the two payment lists. Saying so is the whole difference
  // between this section and the feed it replaced, which dropped rows in
  // silence and left the tenant with no way to know.
  if (d.attention.hasMoreUnresolvedPayments) {
    items.push({
      id: "more-unresolved",
      tone: "warning",
      icon: Clock,
      title: "More payments need attention",
      detail: "Open Billing → Payments to see all of them.",
      badge: "View all",
      to: "/portal/billing?tab=payments",
    });
  }

  const daysLeft = daysUntil(d.lease?.endDate ?? null, today);
  if (daysLeft != null && daysLeft <= LEASE_ENDING_SOON_DAYS) {
    items.push({
      id: "lease-ending",
      tone: daysLeft > 0 ? "warning" : "danger",
      icon: CalendarClock,
      title: daysLeft > 0 ? `Lease ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : "Lease has ended",
      detail: `Ends ${formatDateMY(d.lease!.endDate!)}`,
      // "Ended", not "Expired" — the Lease GlowCard already renders the bare
      // word "Expired" as its value, and two identical text nodes collide in
      // RTL's exact-match getByText.
      badge: daysLeft > 0 ? "Ending soon" : "Ended",
      to: "/portal/my-tenancy",
    });
  }

  return items;
}

/** Whole days from `today` to `endDate`; null when there is no end date. */
function daysUntil(endDate: string | null, today: Date): number | null {
  if (!endDate) return null;
  return Math.ceil((new Date(endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function PortalDashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalDashboardResponse }>("/dashboard"),
  });

  if (isLoading) return <DashboardSkeleton />;

  const d = data?.data;
  if (!d) return null;

  // `upcomingCharges` is capped at 5 by the API and is read for index 0 ONLY —
  // the "Next Due" card. It is not a list to render; see buildAttentionItems.
  const nextCharge = d.upcomingCharges[0];
  const leaseEnd = d.lease?.endDate ? new Date(d.lease.endDate) : null;
  const today = new Date();
  const daysRemaining = daysUntil(d.lease?.endDate ?? null, today);
  // Server-side counts and totals. Deriving these from `upcomingCharges`
  // under-reported, because that array is capped at 5 rows by the API — a
  // tenant with 9 unpaid items was told "5 unpaid item(s)".
  const unpaidCount = d.balance.unpaidCount;
  const attention = buildAttentionItems(d, today);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Home className="h-8 w-8 text-primary" />
          Welcome back, {d.tenant.displayName}
        </h1>
        {d.lease && (
          <p className="text-muted-foreground mt-1">
            {d.lease.propertyName} · Unit {d.lease.unitCode}
          </p>
        )}
      </div>

      {/* Row 1: GlowCards — Balance / Overdue / Next Due / Lease */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard
          glowColor={d.balance.netBalance > 0 ? "gold" : "green"}
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2 flex-1">
              <p className="text-sm font-medium text-muted-foreground">Current Balance</p>
              <p className={`text-3xl font-bold ${d.balance.netBalance > 0 ? "text-rose-600" : "text-emerald-500"}`}>
                {formatRM(d.balance.netBalance)}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Banknote className="h-3 w-3" />
                <span>{unpaidCount} unpaid item(s)</span>
              </div>
              {d.balance.netBalance > 0 && (
                <Link
                  to="/portal/billing?tab=overview"
                  className={cn(buttonVariants({ variant: "gold", size: "sm" }), "w-full justify-center mt-1")}
                >
                  Pay {formatRM(d.balance.netBalance)}
                </Link>
              )}
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10 shrink-0">
              <Banknote className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>

        {/* Overdue — a server-side aggregate over EVERY tenant-visible charge.
            Home previously had no past-due signal at all: a tenant three months
            late saw the same screen as one paid up. */}
        <GlowCard
          glowColor="red"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Overdue</p>
              <p className={`text-3xl font-bold ${d.balance.overdueAmount > 0 ? "text-rose-600" : "text-foreground"}`}>
                {formatRM(d.balance.overdueAmount)}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <AlertTriangle className="h-3 w-3" />
                <span>
                  {d.balance.overdueCount > 0
                    ? `${d.balance.overdueCount} charge${d.balance.overdueCount === 1 ? "" : "s"} past due`
                    : "Nothing past due"}
                </span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-red-500/10 shrink-0">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
          </div>
        </GlowCard>

        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Next Due</p>
              <p className="text-3xl font-bold text-foreground">
                {nextCharge ? formatDateMY(nextCharge.dueDate) : "All clear"}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                {/* outstandingAmount, not amount: what is due next is the
                    post-CN/DN, post-part-payment figure — the same basis as the
                    Balance headline, so the two cannot disagree. */}
                <span>{nextCharge ? `${nextCharge.chargeType} · ${formatRM(nextCharge.outstandingAmount)}` : "No upcoming charges"}</span>
              </div>
              {/* WHY the figure moved. This explanation used to live on the
                  Billing Activity feed row (2026-08-07); that feed is gone, and
                  a silently-adjusted amount is exactly the confusion the note
                  totals were added to prevent. Signed, drawer convention. */}
              {nextCharge && (nextCharge.creditNoteTotal > 0 || nextCharge.debitNoteTotal > 0) && (
                <p className="text-xs text-muted-foreground">
                  {nextCharge.creditNoteTotal > 0 && `credit note -${formatRM(nextCharge.creditNoteTotal)}`}
                  {nextCharge.creditNoteTotal > 0 && nextCharge.debitNoteTotal > 0 && " · "}
                  {nextCharge.debitNoteTotal > 0 && `debit note +${formatRM(nextCharge.debitNoteTotal)}`}
                </p>
              )}
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <CalendarClock className="h-6 w-6 text-orange-600" />
            </div>
          </div>
          {nextCharge && (
            <Link
              to="/portal/billing?tab=invoices"
              className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              View details
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </GlowCard>

        <GlowCard
          glowColor="blue"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Lease</p>
              <p className="text-3xl font-bold text-foreground">
                {daysRemaining != null ? (daysRemaining > 0 ? `${daysRemaining}d` : "Expired") : "Active"}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" />
                <span>{leaseEnd ? `Ends ${formatDateMY(d.lease!.endDate)}` : "Month-to-month"}</span>
              </div>
              {/* Rent and tenancy code were on My Tenancy only; the card showed
                  a bare countdown with nothing identifying WHICH lease. */}
              {d.lease && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Banknote className="h-3 w-3" />
                  <span>{formatRM(d.lease.monthlyRentAmount)}/month · {d.lease.tenancyCode}</span>
                </div>
              )}
            </div>
            <div className="p-3 rounded-xl bg-blue-500/10 shrink-0">
              <FileText className="h-6 w-6 text-blue-600" />
            </div>
          </div>
          <Link
            to="/portal/my-tenancy"
            className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            View
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </GlowCard>
      </div>

      {/* Unspent credit — money the tenant HOLDS, never netted into the Balance
          above it. Same treatment as the Billing Overview tab: netting it into
          "amount due" would understate what is owed today and invite a short
          payment. It was computed by the API but rendered nowhere on Home. */}
      {d.balance.creditAvailable > 0 && (
        <div
          className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"
          data-testid="credit-available"
        >
          <div>
            <p className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
              Credit on your account
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Automatically deducted from your next bill.
            </p>
          </div>
          <p className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
            {formatRM(d.balance.creditAvailable)}
          </p>
        </div>
      )}

      {/* Needs your attention — the exception list that replaced the truncated
          Billing Activity feed. Hidden entirely when there is nothing to act
          on, so its presence alone is the signal. */}
      {attention.length > 0 && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-primary" />
              Needs your attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {attention.map((item) => (
              <Link
                key={item.id}
                to={item.to}
                className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <item.icon className={cn("h-4 w-4 shrink-0", ATTENTION_TONE[item.tone].iconClass)} />
                  <div className="min-w-0">
                    <span className="text-sm text-foreground block">{item.title}</span>
                    <span className="text-xs text-muted-foreground block">{item.detail}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={ATTENTION_TONE[item.tone].badge}>{item.badge}</Badge>
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Row 2: Announcements (conditional) */}
      {d.announcements.length > 0 && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary" />
              Announcements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.announcements.map((a) => (
              <Callout
                key={a.id}
                variant={a.type === "urgent" ? "danger" : a.type === "warning" ? "warning" : "info"}
                title={a.title}
              >
                {a.message}
              </Callout>
            ))}
          </CardContent>
        </Card>
      )}

    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-80 bg-muted rounded" />
      {/* Matches the real layout: 4 GlowCards, then the stacked sections. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-xl" />
        ))}
      </div>
      <div className="h-48 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
    </div>
  );
}
