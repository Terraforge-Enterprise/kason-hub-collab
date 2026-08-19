// apps/web/src/pages/billing/v2/charges-page-v2.tsx
// Charges v2 (2026-07-04 spec §3): Units (default) · Owner billing · All.
// Month lives in the URL (?month=YYYY-MM) for the two month-scoped tabs.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LayoutGrid, ScrollText, Building2, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Segmented } from "@/components/ui/segmented";
import { formatMoney } from "@/components/format";
import { currentMonth, useChargesSummary } from "./use-billing-v2";
import { UnitsTab } from "./units-tab";
import { OwnerBillingTab } from "./owner-tab";
import { AllChargesTab } from "./all-tab";
import { CreateChargeDrawer } from "./create-charge-drawer";

type Tab = "units" | "owner" | "all";

export default function ChargesPageV2() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : currentMonth();
  const [tab, setTab] = useState<Tab>("units");
  const [creating, setCreating] = useState(false);

  const summary = useChargesSummary(month);

  function setMonth(next: string) {
    const p = new URLSearchParams(params);
    p.set("month", next);
    setParams(p, { replace: true });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Charges"
        description="Unit-first billing register. Posting mints the accounting document (IVTEN / DEP); owner lines live on statements."
        metrics={
          summary.data
            ? [
                { label: "Billed", value: formatMoney(summary.data.billedTotal), hint: `${month}` },
                { label: "Posted", value: String(summary.data.postedCount), hint: "Charges live for collection" },
                { label: "Outstanding", value: formatMoney(summary.data.outstandingTotal), hint: "Uncleared exposure" },
                {
                  label: "Units billed",
                  value: `${summary.data.unitsBilled}/${summary.data.unitsWithActiveTenancy}`,
                  hint: "Of units with an active tenancy",
                },
              ]
            : []
        }
      />
      {summary.isError && (
        <Callout variant="danger" title="Couldn't load billing metrics">
          <Button size="sm" variant="outline" onClick={() => summary.refetch()}>Retry</Button>
        </Callout>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="Charges view"
          options={[
            { value: "units", label: "Units", icon: LayoutGrid },
            { value: "owner", label: "Owner billing", icon: Building2 },
            { value: "all", label: "All charges", icon: ScrollText },
          ]}
        />
        <div className="flex items-center gap-3">
          {tab !== "all" && (
            <label className="flex items-center gap-1 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              Month
              <input
                type="month"
                aria-label="Month"
                className="rounded-md border border-[var(--card-border)] bg-transparent px-2 py-1 text-sm"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
          )}
          <Button variant="gold" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-4 w-4" /> Create charge
          </Button>
        </div>
      </div>

      {tab === "units" && <UnitsTab month={month} />}
      {tab === "owner" && <OwnerBillingTab month={month} />}
      {tab === "all" && <AllChargesTab />}

      <CreateChargeDrawer open={creating} onOpenChange={setCreating} />
    </div>
  );
}
