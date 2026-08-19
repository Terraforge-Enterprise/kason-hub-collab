/**
 * AgentCardSection — admin agent-detail "E-Namecard" sub-section.
 *
 * Per spec §7.1, this is the read surface on /parties/agents/:id that
 * shows the agent's currently-active card (rendered via the shared
 * <AgentCardPreview>), version history, and admin action stubs that the
 * Phase 4 mutations (regenerate token / revoke / view public page) will
 * wire up.
 *
 * Coupling notes:
 *   - Reads card history via `useAgentCardHistory(partyId)` from the
 *     admin envelope (`/api/agent-cards/...`) — never the public envelope
 *     (per spec §6.4 ESLint guard).
 *   - Reads org branding from `useOrgCardSettings()` to feed the
 *     <AgentCardPreview> `org` prop. The preview's snapshot fields
 *     (displayName / title / phone / email) come from the active
 *     AgentCardVersion row, not from live Party — this matches what the
 *     public card serves.
 *   - `whatsappPhone` is a LIVE Party field, not snapshotted on
 *     AgentCardVersion. The agent-detail API does not expose it today,
 *     so we accept it as a prop and pass null when the parent doesn't
 *     have it. The admin preview displays primaryPhone visually
 *     regardless; whatsappPhone only affects the public page's
 *     tap-action wrapper, which doesn't render here.
 *   - `publicToken` is intentionally NOT surfaced on the read endpoints
 *     (per spec §6.1). The "Regenerate link" mutation returns the new
 *     token ONCE (so the admin can copy + share it via the toast action);
 *     the "Revoke" mutation only confirms the action — there's no token
 *     to display because the row's column is now NULL.
 *   - "View public page" stays disabled until Phase 6 lands the public
 *     route + a way to fetch the current rotating token without
 *     exposing it on the regular reads.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { EmptyState } from "@/components/empty-state";
import { IdCard, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useAgentCardHistory,
  useRegenerateCardToken,
  useRevokeCard,
  type AgentCardVersion,
} from "@/api/agent-cards";
import { useOrgCardSettings } from "@/api/organization-card-settings";
import { AgentCardPreview } from "@/components/agent-card-preview";

interface Props {
  partyId: string;
  /**
   * Live `Party.whatsappPhone`. Pass null if the calling page doesn't
   * have it — the admin preview still renders correctly (the WhatsApp
   * tap-action lives on the public page, not here).
   */
  whatsappPhone?: string | null;
}

function statusVariant(
  status: AgentCardVersion["status"],
): "emerald" | "amber" | "rose" | "outline" {
  switch (status) {
    case "approved":
      return "emerald";
    case "pending":
      return "amber";
    case "rejected":
      return "rose";
    default:
      return "outline";
  }
}

export function AgentCardSection({ partyId, whatsappPhone }: Props) {
  const { data: versions, isLoading, isError } = useAgentCardHistory(partyId);
  const { data: orgSettings } = useOrgCardSettings();
  const regenerate = useRegenerateCardToken();
  const revoke = useRevokeCard();
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);

  const closeConfirm = () => setConfirm(null);

  const handleRegenerateConfirm = () => {
    closeConfirm();
    regenerate.mutate(partyId, {
      onSuccess: ({ publicToken }) => {
        const url = `${window.location.origin}/card/${publicToken}`;
        toast.success("New public link generated", {
          description: url,
          duration: 10_000,
          action: {
            label: "Copy",
            onClick: () => {
              navigator.clipboard
                .writeText(url)
                .then(() => toast.success("Copied to clipboard"))
                .catch(() => toast.error("Could not copy — select the link manually"));
            },
          },
        });
      },
      onError: (err) => toast.error(`Regenerate failed: ${err.message}`),
    });
  };

  const handleRevokeConfirm = () => {
    closeConfirm();
    revoke.mutate(partyId, {
      onSuccess: () =>
        toast.success("Public link revoked", {
          description: "It may take up to 5 minutes for cached copies to disappear.",
        }),
      onError: (err) => toast.error(`Revoke failed: ${err.message}`),
    });
  };

  if (isLoading) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <IdCard className="h-5 w-5 text-primary" />
            E-Namecard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 bg-muted rounded-xl animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <IdCard className="h-5 w-5 text-primary" />
            E-Namecard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Callout variant="danger" title="Could not load cards">
            Try refreshing the page.
          </Callout>
        </CardContent>
      </Card>
    );
  }

  const history = versions ?? [];
  const active = history.find((v) => v.status === "approved");

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <IdCard className="h-5 w-5 text-primary" />
          E-Namecard
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!active ? (
          <EmptyState
            icon={IdCard}
            title="No card yet"
            description="This agent has no card. They can create one from their portal, or you can edit their profile and add a job title to generate one immediately."
          />
        ) : (
          <>
            <AgentCardPreview
              displayName={active.displayName}
              title={active.title}
              primaryPhone={active.primaryPhone}
              primaryEmail={active.primaryEmail}
              whatsappPhone={whatsappPhone ?? null}
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

            <Callout variant="info" title="Public link">
              The agent shares the public link from their portal. The
              token is not shown here for security — admin actions like
              Regenerate or Revoke land in Phase 4.
            </Callout>

            <div className="flex flex-wrap gap-2 pt-2">
              {/*
                "View public page" intentionally remains disabled — Phase 6
                lands the public route + an admin-side fetch of the
                rotating public token. Wiring it now would require either
                exposing the token on the read endpoint (against spec
                §6.1) or a dedicated reveal mutation (out of scope).
              */}
              <Button
                variant="gold"
                disabled
                onClick={() =>
                  toast.info("Phase 6 will wire this — view the agent's public card")
                }
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                View public page
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirm("regenerate")}
                disabled={regenerate.isPending}
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                {regenerate.isPending ? "Regenerating…" : "Regenerate link"}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirm("revoke")}
                disabled={revoke.isPending}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {revoke.isPending ? "Revoking…" : "Revoke"}
              </Button>
            </div>
          </>
        )}

        {history.length > 0 && (
          <div>
            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2 mt-4">
              Version history ({history.length})
            </h4>
            <div className="space-y-2">
              {history.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-sm min-w-0">
                    <span className="text-foreground truncate">{v.title}</span>
                    <span className="text-muted-foreground shrink-0">·</span>
                    <span className="text-muted-foreground shrink-0">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Badge variant={statusVariant(v.status)}>{v.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/*
        Both destructive — per CRUD pattern §15 they require an
        AlertDialog confirm. The Revoke copy line "This card's public
        link will stop working within 5 minutes." is verbatim from
        spec §9.2 #8 and is load-bearing UX (sets the admin's
        expectation that revocation is not instant due to CloudFront
        s-maxage).
      */}
      <ConfirmAlert
        open={confirm === "regenerate"}
        onCancel={closeConfirm}
        onConfirm={handleRegenerateConfirm}
        title="Generate a new public link?"
        body="The old link will stop working immediately. The new link is shown after confirmation — share it with the agent."
        confirmLabel="Generate new link"
      />
      <ConfirmAlert
        open={confirm === "revoke"}
        onCancel={closeConfirm}
        onConfirm={handleRevokeConfirm}
        title="Revoke this public link?"
        body="This card's public link will stop working within 5 minutes."
        confirmLabel="Revoke link"
        destructive
      />
    </Card>
  );
}
