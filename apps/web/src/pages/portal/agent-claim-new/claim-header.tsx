import { ClipboardList } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/utils";
import type { ClaimType } from "./use-claim-form";

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  isAmending: boolean;
  isEditingDraft: boolean;
  isAgentLevelNotSet: boolean;
  tierErrorMessage: string | null;
  mutationError: Error | null;
  submitBlockedError: string | null;
  claimType: ClaimType;
  onChangeClaimType: (t: ClaimType) => void;
  tierLoading: boolean;
  tierError: Error | null;
  tierPercentage: number;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ClaimHeader({
  isAmending,
  isEditingDraft,
  isAgentLevelNotSet,
  tierErrorMessage,
  mutationError,
  submitBlockedError,
  claimType,
  onChangeClaimType,
  tierLoading,
  tierError,
  tierPercentage,
}: Props) {
  return (
    <>
      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <ClipboardList className="h-8 w-8 text-primary" />
          {isAmending
            ? "Amend Approved Claim"
            : isEditingDraft
              ? "Edit Draft Claim"
              : "Submit Commission Claim"}
        </h1>
        <p className="text-muted-foreground mt-1">
          {isAmending
            ? "Editing this approved claim will flip it back to Amended and require admin re-approval."
            : isEditingDraft
              ? "Modify draft details, then save or submit when ready"
              : "Fill in the claim details below"}
        </p>
      </div>

      {/* ── Alert messages ──────────────────────────────────────────────── */}
      {isAmending && (
        <Callout variant="warning" title="Heads up">
          Saving will flip this claim back to <span className="font-semibold">Amended</span> and
          require admin re-approval before payout.
        </Callout>
      )}
      {isAgentLevelNotSet && (
        <Callout variant="warning">
          Your agent level has not been configured. Please contact your admin.
        </Callout>
      )}
      {tierErrorMessage && !isAgentLevelNotSet && (
        <Callout variant="danger">
          {tierErrorMessage}
        </Callout>
      )}
      {mutationError && !submitBlockedError && (
        <Callout variant="danger">
          {(mutationError as Error).message}
        </Callout>
      )}
      {submitBlockedError && (
        <Callout variant="warning" title="Submission Blocked">
          {submitBlockedError}
        </Callout>
      )}

      {/* ── Claim Type — Card Selector ──────────────────────────────────── */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg font-semibold">Claim Type</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <button
              type="button"
              onClick={() => onChangeClaimType("tenant_portion")}
              className={cn(
                "rounded-xl border-2 p-4 text-left transition-all",
                claimType === "tenant_portion"
                  ? "border-[var(--gold)] bg-[var(--gold)]/5 shadow-md"
                  : "border-border/50 bg-background/40 hover:border-border/80"
              )}
            >
              <div className="font-semibold text-foreground">Tenant Portion</div>
              <div className="text-xs text-muted-foreground mt-1">Agent helps the tenant find a house</div>
            </button>
            <button
              type="button"
              onClick={() => onChangeClaimType("listing_portion")}
              className={cn(
                "rounded-xl border-2 p-4 text-left transition-all",
                claimType === "listing_portion"
                  ? "border-[var(--gold)] bg-[var(--gold)]/5 shadow-md"
                  : "border-border/50 bg-background/40 hover:border-border/80"
              )}
            >
              <div className="font-semibold text-foreground">Listing Portion</div>
              <div className="text-xs text-muted-foreground mt-1">Agent represents the owner's listing</div>
            </button>
            <button
              type="button"
              onClick={() => onChangeClaimType("tenant_listing_portion")}
              className={cn(
                "rounded-xl border-2 p-4 text-left transition-all",
                claimType === "tenant_listing_portion"
                  ? "border-[var(--gold)] bg-[var(--gold)]/5 shadow-md"
                  : "border-border/50 bg-background/40 hover:border-border/80"
              )}
            >
              <div className="font-semibold text-foreground">Tenant + Listing Portion</div>
              <div className="text-xs text-muted-foreground mt-1">Direct deal with owner AND sources the tenant</div>
            </button>
          </div>

          {/* Agent Tier display */}
          <div className="flex items-center gap-2 mt-3">
            <span className="text-sm text-muted-foreground">Agent Tier:</span>
            <Badge variant="outline" className="text-sm">
              {tierLoading ? "..." : tierError ? "-" : `${tierPercentage}%`}
            </Badge>
            <span className="text-xs text-muted-foreground">(auto-calculated, read-only)</span>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
