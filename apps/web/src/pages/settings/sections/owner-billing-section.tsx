// Settings → Owner Billing (M6) — READ-ONLY owner readiness overview (R4). Setup
// + edit moved to the owner detail (Tenants & Owners → Owners → owner → Set up
// billing / Edit fee, Task 5). This page is the fleet "who's billable / who's
// missing" gap-finder that pairs with the charge-post guard (R2/R3): each owner
// shows Set up (+ its active fee summary) or Missing (⚠), linking into the owner
// detail. No write affordances live here anymore (New / Edit / Retire / Restore
// all removed) — the underlying write endpoints + FeeConfigDrawer are untouched
// and still used from the owner detail.
//
// Flag-gated: this section is only registered in the Settings rail + router when
// ENABLE_PHASE2_OWNER_BILLING is on (see settings-layout.tsx + router.tsx).
// Viewable by manager and above (matches the requireRole("manager") read
// endpoints it calls: /parties/owners + /owner-billing/fee-configs).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, Receipt } from "lucide-react";
import { computeManagementFee, type ManagementFeeConfig } from "@kason/shared";
import { PageHeader } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { apiFetch } from "@/lib/api-client";
import { useAllActiveFeeConfigs, type FeeConfigRow } from "@/api/owner-billing";

const SAMPLE_RENT = "2000";

/** Effective-% label for an owner's active config — same shared math the backend
 * uses (mirrors the retired table's `effectiveLabel`). Defensive: a malformed row
 * (e.g. cap without capAmount) never crashes the overview — falls back to the
 * raw fee value. */
function feeSummary(c: FeeConfigRow): string {
  const cfg: ManagementFeeConfig = {
    feeType: c.feeType,
    feeValue: c.feeValue,
    capAmount: c.capAmount,
    sstPercent: c.sstPercent,
  };
  try {
    const label = computeManagementFee(cfg, SAMPLE_RENT).effectivePercentLabel;
    return c.feeType === "fixed"
      ? `RM${c.feeValue} + ${c.sstPercent}% SST`
      : `${c.feeValue}% + ${c.sstPercent}% SST (eff. ${label})`;
  } catch {
    return `${c.feeValue}`;
  }
}

export default function OwnerBillingSettingsPage() {
  const ownersQuery = useQuery({
    queryKey: ["owners"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>("/parties/owners"),
  });
  const configsQuery = useAllActiveFeeConfigs();

  // owner → its first active config (owners usually carry exactly one; when an
  // owner has both an all-properties default and a property-scoped override,
  // the FIRST-resolved config wins deterministically rather than whichever the
  // loop visits last).
  const configByOwner = useMemo(() => {
    const map = new Map<string, FeeConfigRow>();
    for (const c of configsQuery.data ?? []) {
      if (!map.has(c.ownerPartyId)) map.set(c.ownerPartyId, c);
    }
    return map;
  }, [configsQuery.data]);

  const owners = ownersQuery.data?.data ?? [];

  // Gate on loading BEFORE rendering owner rows: useAllActiveFeeConfigs can still
  // be paging after ownersQuery resolves, and an empty configByOwner would flash
  // every owner as "Missing" (the exact wrong signal for a gap-finder) until it
  // catches up. Skeleton mirrors the sibling Settings sections' loading convention
  // (e.g. utilities-section.tsx, billing-config-section.tsx).
  if (ownersQuery.isLoading || configsQuery.isLoading) {
    return (
      <div className="space-y-6 animate-pulse" data-testid="owner-billing-loading">
        <div className="h-16 bg-muted rounded-xl" />
        <div className="h-32 bg-muted rounded-xl" />
      </div>
    );
  }

  if (ownersQuery.isError || configsQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Owner Billing"
          icon={Receipt}
          description="Per-owner billing readiness. Set up an owner's fee from their detail page."
        />
        <Callout variant="danger" title="Couldn't load owner billing">
          Failed to load owner billing readiness. Please refresh.
        </Callout>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Owner Billing"
        icon={Receipt}
        description="Per-owner billing readiness. Set up an owner's fee from their detail page."
      />

      <Callout variant="info" title="How setup works">
        Fees are set up per owner from <b>Tenants &amp; Owners → Owners → (owner) → Set up
        billing</b>. A unit&apos;s charges can&apos;t be posted until its owner is set up. This
        page is the fleet overview of who&apos;s ready.
      </Callout>

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-0 divide-y divide-border/40" data-testid="owner-billing-list">
          {owners.map((o) => {
            const cfg = configByOwner.get(o.id);
            return (
              <Link
                key={o.id}
                to="/parties/owners"
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-white/[0.03]"
              >
                <span className="font-medium">{o.displayName}</span>
                {cfg ? (
                  <span className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">{feeSummary(cfg)}</span>
                    <Badge variant="emerald">Set up</Badge>
                  </span>
                ) : (
                  <Badge variant="outline" className="flex items-center gap-1 text-amber-600">
                    <AlertTriangle className="h-3.5 w-3.5" /> Missing
                  </Badge>
                )}
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
