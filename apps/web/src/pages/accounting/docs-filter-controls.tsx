// Shared filter controls for the accounting document registers (Invoices +
// Receipts). Renders Owner/Tenant tabs + a filter row (Property, Status, search by
// doc#/name/phone, and an issued-date range) and emits a normalized filter value the
// page feeds to useBillingDocuments. All filtering is server-side (the page is
// paginated), so a filter narrows the WHOLE result set, not just the visible page.
import { useState } from "react";
import { Building2, Home, LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListFilterBar, filterControlClass, type ListFilterState } from "@/components/list-filter-bar";
import { usePropertyOptions } from "@/api/billing-documents";

export type DocsFilterValue = {
  /** undefined = the "All" tab. */
  counterpartyType?: "tenant" | "owner";
  q?: string;
  status?: string;
  propertyId?: string;
  dateFrom?: string;
  dateTo?: string;
};

const TABS = [
  { value: "all", label: "All", Icon: LayoutGrid },
  { value: "tenant", label: "Tenant", Icon: Home },
  { value: "owner", label: "Owner", Icon: Building2 },
] as const;

export function DocsFilterControls({
  statusOptions,
  searchPlaceholder = "Search doc #, name, or phone…",
  onChange,
}: {
  statusOptions: { value: string; label: string }[];
  searchPlaceholder?: string;
  onChange: (v: DocsFilterValue) => void;
}) {
  const [tab, setTab] = useState<"all" | "tenant" | "owner">("all");
  const [bar, setBar] = useState<ListFilterState>({
    search: "",
    sort: "",
    order: "desc",
    extras: { status: "all", propertyId: "all" },
  });
  const properties = usePropertyOptions();

  function emit(nextTab: string, nextBar: ListFilterState) {
    const status = String(nextBar.extras.status ?? "all");
    const propertyId = String(nextBar.extras.propertyId ?? "all");
    onChange({
      counterpartyType: nextTab === "all" ? undefined : (nextTab as "tenant" | "owner"),
      q: nextBar.search.trim() || undefined,
      status: status === "all" ? undefined : status,
      propertyId: propertyId === "all" ? undefined : propertyId,
      dateFrom: nextBar.from || undefined,
      dateTo: nextBar.to || undefined,
    });
  }

  function selectTab(value: "all" | "tenant" | "owner") {
    setTab(value);
    emit(value, bar);
  }

  function setExtra(key: "status" | "propertyId", v: string) {
    const next = { ...bar, extras: { ...bar.extras, [key]: v } };
    setBar(next);
    emit(tab, next);
  }

  return (
    <div className="space-y-4">
      {/* Owner / Tenant tabs — the primary split. */}
      <div className="flex flex-wrap gap-1 border-b border-border/50">
        {TABS.map((t) => {
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              aria-pressed={active}
              onClick={() => selectTab(t.value)}
              className={cn(
                "relative -mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
                active
                  ? "border-[#D4AF37] text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <t.Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <ListFilterBar
        value={bar}
        onChange={(next) => {
          setBar(next);
          emit(tab, next);
        }}
        searchPlaceholder={searchPlaceholder}
        dateFields={[{ value: "issuedAt", label: "Issued date" }]}
        extras={
          <>
            <select
              aria-label="Property"
              className={filterControlClass}
              value={String(bar.extras.propertyId ?? "all")}
              onChange={(e) => setExtra("propertyId", e.target.value)}
            >
              <option value="all">All properties</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Status"
              className={filterControlClass}
              value={String(bar.extras.status ?? "all")}
              onChange={(e) => setExtra("status", e.target.value)}
            >
              {statusOptions.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        }
      />
    </div>
  );
}
