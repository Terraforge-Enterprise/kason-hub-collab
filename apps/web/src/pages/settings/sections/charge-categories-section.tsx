/**
 * Settings → Charge Categories — REDIRECT ONLY (2026-08-03).
 *
 * The charge-category table now lives inside Settings → Billing Config as a panel
 * (charge-categories-panel.tsx, rendered by billing-config-section.tsx). This route is
 * kept — rather than deleted — so existing bookmarks and any in-app link to
 * /settings/charge-categories still land somewhere useful instead of 404ing. The nav
 * entry for it was removed from settings-layout.tsx.
 *
 * FALLBACK (not dead code): Billing Config only exists when ENABLE_PHASE2_AUTODRAFT is
 * on, while this route is gated on ENABLE_PHASE2_BILLING_DOCS. In the flag combination
 * where BILLING_DOCS is on but AUTODRAFT is off, redirecting would bounce to a route
 * that isn't registered — so we render the panel in place instead. Both flags are
 * currently true in local/UAT/prod, making the redirect the live path.
 */
import { Navigate } from "react-router-dom";
import { Tags } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { ChargeCategoriesPanel } from "./charge-categories-panel";

export default function ChargeCategoriesSettingsPage() {
  if (isPhase2FlagEnabled("ENABLE_PHASE2_AUTODRAFT")) {
    return <Navigate to="/settings/billing-config" replace />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Charge Categories"
        icon={Tags}
        description="The list behind every Category dropdown — expense drawers, the charge form and recurring charges."
      />
      <ChargeCategoriesPanel />
    </div>
  );
}
