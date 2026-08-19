import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  LayoutDashboard, Workflow, ClipboardList, Hammer, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRM } from "@/components/format";
import { fetchAgentHomeSummary } from "@/api/portal-agent-home";
import {
  useMyCard,
  useReconfirmMyCard,
  useWithdrawMyCard,
  getMyCardErrorCode,
} from "@/api/portal-my-card";
import { MyCardStateBanner } from "../my-card-state-banner";
import { MyCardEditSheet } from "../my-card-edit-sheet";
import { formatLongDate } from "../my-card-utils";
import { DomainSummaryCard } from "./domain-summary-card";
import { PendingActionFeed } from "./pending-action-feed";
import { RecentActivity } from "./recent-activity";

export default function AgentHomePage() {
  // Edit Sheet is hosted right here on the dashboard so the banner's primary
  // action ("Set up my card" / "Edit & re-submit") opens the form directly
  // instead of navigating to /portal/my-card and forcing a second click.
  const [editOpen, setEditOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["agent-home-summary"],
    queryFn: fetchAgentHomeSummary,
  });

  // Mirror the My Card state banner at the top so the agent doesn't
  // have to navigate to /portal/my-card to see pending / expiring /
  // cap-reached / no-card prompts (per spec §7.2 portal home extension).
  // Reconfirm + withdraw fire from here too — the same mutations the
  // dedicated page uses, so the cache invalidation flows through.
  const myCard = useMyCard();
  const reconfirm = useReconfirmMyCard();
  const withdraw = useWithdrawMyCard();

  const handleCardAction = (action: "open-edit" | "reconfirm" | "withdraw") => {
    // open-edit fires the SAME Sheet the dedicated /portal/my-card page uses.
    // No navigation: clicking the dashboard banner directly opens the form.
    // (Was: navigate("/portal/my-card") — caused a double-click since the
    // destination page renders the same banner with the same button.)
    if (action === "open-edit") {
      setEditOpen(true);
      return;
    }
    if (action === "reconfirm") {
      reconfirm.mutate(undefined, {
        onSuccess: ({ newExpiresAt }) =>
          toast.success("Card re-confirmed", {
            description: `New expiry: ${formatLongDate(newExpiresAt)}.`,
          }),
        onError: (err) => {
          const code = getMyCardErrorCode(err);
          if (code === "rate_limited") {
            toast.error("Re-confirm allowed once per day. Try again tomorrow.");
          } else if (code === "cap_reached") {
            toast.error("Re-confirm cap reached. Submit a fresh card for re-approval.");
          } else if (code === "not_in_window") {
            toast.error("Re-confirm only available within 30 days of expiry.");
          } else {
            toast.error(`Re-confirm failed: ${err.message}`);
          }
        },
      });
      return;
    }
    if (action === "withdraw") {
      withdraw.mutate(undefined, {
        onSuccess: () => toast.success("Submission withdrawn"),
        onError: (err) => toast.error(`Withdraw failed: ${err.message}`),
      });
    }
  };

  if (isLoading) return <PageSkeleton />;

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load your dashboard.</p>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl md:text-4xl font-bold flex items-center gap-3">
          <LayoutDashboard className="h-8 w-8 text-primary" />
          Dashboard
        </h1>
        <p className="text-muted-foreground mt-1">What's happening across your work right now.</p>
      </header>

      {/*
        E-Namecard state banner (spec §7.2). Renders one of five
        branches (no-card / cap-reached / pending / rejected /
        expiring-soon) or null when the active card is healthy. Only
        agents see this — the parent route already gates on userType.
      */}
      {myCard.data && (
        <MyCardStateBanner
          data={myCard.data}
          onAction={handleCardAction}
          reconfirming={reconfirm.isPending}
          withdrawing={withdraw.isPending}
        />
      )}

      <PendingActionFeed rows={data.pendingActions} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <DomainSummaryCard
          title="Pipeline" icon={Workflow} glowColor="blue"
          statusCounts={data.pipeline?.counts ?? null}
          deepLink={{ label: "Open Sales Pipeline", href: "/portal/sales-pipeline" }}
        />
        <DomainSummaryCard
          title="Sales Claims" icon={ClipboardList} glowColor="orange"
          statusCounts={data.salesClaims?.counts ?? null}
          primaryMetric={data.salesClaims ? { label: "Approved this month", value: formatRM(data.salesClaims.approvedThisMonth) } : undefined}
          deepLink={{ label: "Open Sales Claims", href: "/portal/sales-claims" }}
        />
        <DomainSummaryCard
          title="Renovation Claims" icon={Hammer} glowColor="green"
          statusCounts={data.renovationClaims?.counts ?? null}
          primaryMetric={data.renovationClaims ? { label: "Approved this month", value: formatRM(data.renovationClaims.approvedThisMonth) } : undefined}
          deepLink={{ label: "Open Renovation Claims", href: "/portal/renovation-claims" }}
        />
        <DomainSummaryCard
          title="Commission" icon={Wallet} glowColor="gold"
          statusCounts={data.commission ? {} : null}
          primaryMetric={data.commission ? { label: "Earned this month", value: formatRM(data.commission.earnedThisMonth) } : undefined}
          deepLink={{ label: "Open Commission Analytics →", href: "/portal/commissions/dashboard" }}
        />
      </div>

      <RecentActivity rows={data.recentActivity} />

      {data.errors.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Some data couldn't be loaded: {data.errors.join(", ")}.{" "}
          <button onClick={() => refetch()} className="underline">Retry</button>
        </p>
      )}

      {/* My-card edit Sheet, hosted here so the banner can open it inline.
          `initial` pre-fills the form from the agent's currently-active card
          (or null if no card yet). The Sheet handles its own data fetching
          internally; once submitted, useMyCard's TanStack cache invalidates
          and the banner state updates without a navigation. */}
      <MyCardEditSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={myCard.data?.active ?? null}
      />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-64 bg-muted rounded" />
      <div className="h-40 bg-muted rounded-xl" />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-48 bg-muted rounded-xl" />)}
      </div>
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}
