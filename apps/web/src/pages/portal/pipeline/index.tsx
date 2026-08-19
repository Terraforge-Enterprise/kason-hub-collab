import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { SalesTab } from "./sales-tab";
import { RentalsTab } from "./rentals-tab";
import { SalesEntryDrawer } from "./sales-entry-drawer";
import { RentalEntryDrawer } from "./rental-entry-drawer";
import { UnitDetailDrawer } from "./unit-detail-drawer";
import type { TabKey } from "./types";

export default function PipelinePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabKey = searchParams.get("tab") === "rentals" ? "rentals" : "sales";
  const [newOpen, setNewOpen] = useState<"sales" | "rentals" | null>(null);
  const unitId = searchParams.get("unit");

  function setTab(next: TabKey) {
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  }

  function closeDetail() {
    const sp = new URLSearchParams(searchParams);
    sp.delete("unit");
    setSearchParams(sp, { replace: true });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description="Track unit progress: sales entries through renovation, rentals through admin approval."
        actions={
          <div className="flex gap-2">
            <Button variant="gold" onClick={() => setNewOpen("sales")}>
              <Plus className="h-4 w-4" /> New Sales Entry
            </Button>
            <Button variant="outline" onClick={() => setNewOpen("rentals")}>
              <Plus className="h-4 w-4" /> New Rental Entry
            </Button>
          </div>
        }
      />

      <TabSwitcher tab={tab} onChange={setTab} />

      {tab === "sales" ? <SalesTab /> : <RentalsTab />}

      {/* Drawers — wired in Tasks 9 (Sales Entry) + 10 (Rental Entry) + 11 (Unit Detail) */}
      {newOpen === "sales" && (
        <SalesEntryDrawer open onClose={() => setNewOpen(null)} />
      )}
      {newOpen === "rentals" && (
        <RentalEntryDrawer open onClose={() => setNewOpen(null)} />
      )}
      {unitId && <UnitDetailDrawer unitId={unitId} onClose={closeDetail} />}
    </div>
  );
}

function TabSwitcher({ tab, onChange }: { tab: TabKey; onChange: (next: TabKey) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Pipeline category"
      className="inline-flex rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
    >
      {(
        [
          { key: "sales", label: "Sales" },
          { key: "rentals", label: "Rentals" },
        ] as const
      ).map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={
              active
                ? "rounded-md bg-[var(--primary)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm"
                : "rounded-md px-4 py-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
