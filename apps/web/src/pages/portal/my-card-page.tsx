/**
 * Portal /portal/my-card page (per spec §7.2).
 *
 * Composition (top → bottom):
 *   1. Page header: 3xl bold + IdCard icon + "My E-Namecard" title
 *   2. State-banner row (one of five branches — see <MyCardStateBanner>)
 *   3. Stat row (4× <GlowCard>) — only when active card exists:
 *      - Card status   (badge: emerald=approved, amber=pending elsewhere)
 *      - Approved on   (long-form date)
 *      - Expires in    (days remaining; orange tint when < 30)
 *      - Reconfirms used (X/4)
 *   4. Live card panel — <Card> glassmorphism wrapping
 *      <AgentCardPreview> + public-link copy box + 3 actions
 *      (Download PNG / View public page / Share via WhatsApp)
 *   5. Edit Card button — opens the <MyCardEditSheet>
 *
 * Per the design-system rules (.claude/skills/frontend/SKILL.md):
 *   - GlowCard for stat tiles
 *   - Card + glassmorphism for content
 *   - Callout variants for state banners
 *   - EmptyState for no-card-yet
 *   - Button gold variant for primary CTAs
 *   - Sheet for the edit drawer
 *   - FormCard + form-ui for the form
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  IdCard,
  ShieldCheck,
  CalendarCheck,
  Clock,
  RotateCw,
  ExternalLink,
  Download,
  MessageCircle,
  Copy,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { GlowCard } from "@/components/ui/glow-card";
import { AgentCardPreview } from "@/components/agent-card-preview";
import { useOrgCardSettings } from "@/api/organization-card-settings";
import {
  useMyCard,
  useReconfirmMyCard,
  useWithdrawMyCard,
  daysUntilExpiry,
  getMyCardErrorCode,
} from "@/api/portal-my-card";
import { MyCardEditSheet } from "./my-card-edit-sheet";
import { MyCardStateBanner } from "./my-card-state-banner";
import { formatLongDate } from "./my-card-utils";

export default function MyCardPage() {
  const { data, isLoading, isError, refetch } = useMyCard();
  const { data: orgSettings } = useOrgCardSettings();
  const reconfirm = useReconfirmMyCard();
  const withdraw = useWithdrawMyCard();
  const [editOpen, setEditOpen] = useState(false);

  const handleAction = (action: "open-edit" | "reconfirm" | "withdraw") => {
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

  const publicUrl = useMemo(() => {
    if (!data?.active?.publicToken) return null;
    return `${window.location.origin}/card/${data.active.publicToken}`;
  }, [data?.active?.publicToken]);

  const handleCopyLink = () => {
    if (!publicUrl) return;
    navigator.clipboard
      .writeText(publicUrl)
      .then(() => toast.success("Public link copied"))
      .catch(() => toast.error("Could not copy — select the link manually"));
  };

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-72 bg-muted rounded" />
        <div className="h-32 bg-muted rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 bg-muted rounded-xl" />
          ))}
        </div>
        <div className="h-96 bg-muted rounded-xl" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Callout variant="danger" title="Could not load your card">
          <p>Try refreshing.</p>
          <div className="mt-3">
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </Callout>
      </div>
    );
  }

  const { active, pending } = data;
  // Disable "Edit card" while a pending submission is in flight — the
  // backend would reject the second submit with 409 anyway, but blocking
  // it at the UI layer is the cleaner UX.
  const editDisabled = Boolean(pending);
  const expiryDays = daysUntilExpiry(active?.expiresAt);

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* State-banner row — at most one of the five branches renders. */}
      <MyCardStateBanner
        data={data}
        onAction={handleAction}
        reconfirming={reconfirm.isPending}
        withdrawing={withdraw.isPending}
      />

      {/* Stat row — only when an active card exists. */}
      {active && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <GlowCard
            glowColor="green"
            className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Card status</p>
                <div>
                  <Badge variant={pending ? "amber" : "emerald"}>
                    {pending ? "Update pending" : "Live"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {pending
                    ? "Public link still shows the approved version"
                    : "Public link is active"}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-green-500/10">
                <ShieldCheck className="h-6 w-6 text-green-600" />
              </div>
            </div>
          </GlowCard>

          <GlowCard
            glowColor="blue"
            className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Approved on</p>
                <p className="text-2xl font-bold text-foreground">
                  {formatLongDate(active.approvedAt)}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-blue-500/10">
                <CalendarCheck className="h-6 w-6 text-blue-600" />
              </div>
            </div>
          </GlowCard>

          <GlowCard
            glowColor={expiryDays !== null && expiryDays < 30 ? "orange" : "purple"}
            className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Expires in</p>
                <p
                  className={
                    expiryDays !== null && expiryDays < 30
                      ? "text-3xl font-bold text-orange-600"
                      : "text-3xl font-bold text-foreground"
                  }
                >
                  {expiryDays === null
                    ? "—"
                    : expiryDays <= 0
                      ? "Today"
                      : `${expiryDays} ${expiryDays === 1 ? "day" : "days"}`}
                </p>
                {active.expiresAt && (
                  <p className="text-xs text-muted-foreground">
                    On {formatLongDate(active.expiresAt)}
                  </p>
                )}
              </div>
              <div
                className={
                  expiryDays !== null && expiryDays < 30
                    ? "p-3 rounded-xl bg-orange-500/10"
                    : "p-3 rounded-xl bg-purple-500/10"
                }
              >
                <Clock
                  className={
                    expiryDays !== null && expiryDays < 30
                      ? "h-6 w-6 text-orange-600"
                      : "h-6 w-6 text-purple-600"
                  }
                />
              </div>
            </div>
          </GlowCard>

          <GlowCard
            glowColor={active.reconfirmCount >= 4 ? "red" : "gold"}
            className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Reconfirms used</p>
                <p
                  className={
                    active.reconfirmCount >= 4
                      ? "text-3xl font-bold text-red-600"
                      : "text-3xl font-bold text-foreground"
                  }
                >
                  {active.reconfirmCount}/4
                </p>
                <p className="text-xs text-muted-foreground">
                  {active.reconfirmCount >= 4
                    ? "Re-approval required to continue"
                    : "Reset on each manager re-approval"}
                </p>
              </div>
              <div
                className={
                  active.reconfirmCount >= 4
                    ? "p-3 rounded-xl bg-red-500/10"
                    : "p-3 rounded-xl bg-amber-500/10"
                }
              >
                <RotateCw
                  className={
                    active.reconfirmCount >= 4
                      ? "h-6 w-6 text-red-600"
                      : "h-6 w-6 text-amber-600"
                  }
                />
              </div>
            </div>
          </GlowCard>
        </div>
      )}

      {/* Live card panel + actions — only when active card exists. */}
      {active && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <IdCard className="h-5 w-5 text-primary" />
              Live card
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <AgentCardPreview
              displayName={active.displayName}
              title={active.title}
              primaryPhone={active.primaryPhone}
              primaryEmail={active.primaryEmail}
              org={{
                agencyName: orgSettings?.agencyName ?? null,
                agencyLicense: orgSettings?.agencyLicense ?? null,
                agencyPhone: orgSettings?.agencyPhone ?? null,
                agencyFax: orgSettings?.agencyFax ?? null,
                address: [
                  orgSettings?.addressLine1,
                  orgSettings?.addressLine2,
                  orgSettings?.addressLine3,
                  orgSettings?.addressLine4,
                ].filter((l): l is string => Boolean(l && l.trim())),
                logoUrl: "/logo-gold.png",
              }}
            />

            {publicUrl && (
              <div className="flex flex-col gap-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Public link
                </p>
                <div className="flex items-stretch gap-2">
                  <input
                    readOnly
                    value={publicUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm text-foreground font-mono"
                  />
                  <Button variant="outline" onClick={handleCopyLink}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              {/*
                PNG download lands in Phase 6 (separate Vite bundle for the
                public route + html2canvas dep). The button is shown today
                for layout completeness with a tooltip-shaped hint via the
                disabled-styled toast.
              */}
              <Button
                variant="gold"
                disabled
                title="Phase 6 will wire this — PNG download via html2canvas"
                onClick={() => toast.info("Phase 6 will enable PNG download")}
              >
                <Download className="h-4 w-4 mr-1" />
                Download PNG
              </Button>
              <Button
                variant="outline"
                onClick={() => publicUrl && window.open(publicUrl, "_blank", "noopener")}
                disabled={!publicUrl}
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                View public page
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (!publicUrl) return;
                  const text = `Check out my e-namecard: ${publicUrl}`;
                  window.open(
                    `https://wa.me/?text=${encodeURIComponent(text)}`,
                    "_blank",
                    "noopener",
                  );
                }}
                disabled={!publicUrl}
              >
                <MessageCircle className="h-4 w-4 mr-1" />
                Share via WhatsApp
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit CTA — disabled while a pending submission is in flight. */}
      {(active || pending) && (
        <div className="flex justify-end">
          <Button
            variant="gold"
            onClick={() => setEditOpen(true)}
            disabled={editDisabled}
            title={
              editDisabled
                ? "Withdraw your pending submission first to edit again"
                : undefined
            }
          >
            <IdCard className="h-4 w-4 mr-1" />
            Edit card
          </Button>
        </div>
      )}

      <MyCardEditSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={active ?? null}
      />
    </div>
  );
}

function PageHeader() {
  return (
    <header>
      <h1 className="text-3xl md:text-4xl font-bold flex items-center gap-3">
        <IdCard className="h-8 w-8 text-primary" />
        My E-Namecard
      </h1>
      <p className="text-muted-foreground mt-1">
        Your branded contact card. Edits go to your manager for approval.
      </p>
    </header>
  );
}
