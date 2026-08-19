// Admin Owner-Ledger page (M6b). Three-tab layout — this is the "Owner Ledger",
// so it opens OWNER-first:
//   • "Owners" (DEFAULT) — premium owner-list landing (see ./owner-ledger/
//     owners-tab.tsx): GlowCard summary row + owner table with per-unit
//     expand. Smart search matches owner name OR unit code, so Yannie's
//     unit-first lookup still works from here. Owner-first surfaces (combined
//     statements / running balance / payouts) stay owner-scoped downstream.
//   • "Units" — org-wide unit-first grid (./owner-ledger/units-tab.tsx), the
//     power view for searching a single unit across all owners.
//   • "All entries" — the flat entries table (power-user view) with the 7
//     filters collapsed into a Filters ▾ panel + dismissible chips.
//
// Existing capabilities preserved: EntryFormDrawer (New entry only — ledger
// entries are read-only, no per-row edit), MonthReviewSheet, void flow, pagination.
//
// Flag-gated: route + nav only exist when ENABLE_PHASE2_OWNER_BILLING is on.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Plus, RefreshCw, X } from "lucide-react";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { PageHeader, StatusPill } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectInput, TextInput } from "@/components/form-ui";
import { EnhancedDataTable } from "@/components/data-table";
import { PillBar } from "@/components/ui/pill-bar";
import { Segmented } from "@/components/ui/segmented";
import { PaidByBadge } from "@/components/paid-by-badge";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { apiFetch } from "@/lib/api-client";
import { currentMonth } from "@/lib/date-utils";
import { labelFor } from "@/lib/string-utils";
import {
  useOwnerLedgerEntries,
  useVoidLedgerEntry,
  type OwnerLedgerEntryRow,
  type OwnerLedgerFilters,
} from "@/api/owner-ledger";
import { EntryFormDrawer } from "./owner-ledger/entry-form-drawer";
import { MonthReviewSheet } from "./owner-ledger/month-review-sheet";
import { UnitsTab } from "./owner-ledger/units-tab";
import { OwnersTab } from "./owner-ledger/owners-tab";
import type {
  OwnerLedgerDirection,
  OwnerLedgerCategory,
  OwnerPaidBy,
  OwnerPaymentStatus,
} from "@kason/shared";
import {
  OWNER_LEDGER_CATEGORIES,
} from "@kason/shared";

const PAGE_SIZE = 20;

// ─── Filter option lists ───────────────────────────────────────────────────────

const DIRECTION_OPTIONS: { value: OwnerLedgerDirection; label: string }[] = [
  { value: "income",  label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "payout",  label: "Payout" },
];

const PAID_BY_OPTIONS: { value: OwnerPaidBy; label: string }[] = [
  { value: "kaen",      label: "Kaen" },
  { value: "owner",     label: "Owner" },
  { value: "tenant",    label: "Tenant" },
  { value: "developer", label: "Developer" },
  { value: "other",     label: "Other" },
];

const PAYMENT_STATUS_OPTIONS: { value: OwnerPaymentStatus; label: string }[] = [
  { value: "paid",        label: "Paid" },
  { value: "pending",     label: "Pending" },
  { value: "reimbursed",  label: "Reimbursed" },
  { value: "partial",     label: "Partial" },
  { value: "waived",      label: "Waived" },
  { value: "cancelled",   label: "Cancelled" },
];

const CATEGORY_SELECT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All categories" },
  ...OWNER_LEDGER_CATEGORIES.map((c) => ({
    value: c,
    label: labelFor(c),
  })),
];

// ─── Types ────────────────────────────────────────────────────────────────────

type TabValue = "units" | "owners" | "all-entries";

type OverlayState =
  | { kind: "new" }
  | { kind: "void"; entry: OwnerLedgerEntryRow }
  | { kind: "month-review"; ownerPartyId: string; month: string }
  | null;

// ─── Active filter chip model ─────────────────────────────────────────────────

type FilterChip = {
  id: string;
  label: string;
  onDismiss: () => void;
};

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function OwnerLedgerPage() {
  // ── Tab state ────────────────────────────────────────────────────────────────
  // Owner-first front door: the page is the "Owner Ledger", so it opens on
  // owners. Unit lookup is preserved inside OwnersTab (smart search matches unit
  // codes; owner rows expand to per-unit sub-rows that deep-link to the unit
  // workspace). Units + All entries remain as secondary tabs.
  const [activeTab, setActiveTab] = useState<TabValue>("owners");

  // ── All-entries tab state ────────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState(""); // YYYY-MM
  const [directionFilter, setDirectionFilter] = useState<OwnerLedgerDirection | "">("");
  const [paidByFilter, setPaidByFilter] = useState<OwnerPaidBy | "">("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<OwnerPaymentStatus | "">("");
  const [categoryFilter, setCategoryFilter] = useState<OwnerLedgerCategory | "">("");
  const [page, setPage] = useState(0);

  const [overlay, setOverlay] = useState<OverlayState>(null);
  const voidEntry = useVoidLedgerEntry();

  // ── Owner options (shared by both tabs for label resolution) ─────────────────
  const ownersQuery = useQuery({
    queryKey: ["owners"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>("/parties/owners"),
  });
  const owners = useMemo(() => ownersQuery.data?.data ?? [], [ownersQuery.data]);
  const ownerName = useMemo(() => {
    const map = new Map(owners.map((o) => [o.id, o.displayName]));
    return (id: string | null | undefined) =>
      id == null ? "Unknown owner" : (map.get(id) ?? "Unknown owner");
  }, [owners]);

  // ── Property options ─────────────────────────────────────────────────────────
  const propertiesQuery = useQuery({
    queryKey: ["properties"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string }> }>("/inventory/properties"),
  });
  const properties = useMemo(
    () => propertiesQuery.data?.data ?? [],
    [propertiesQuery.data],
  );
  const propertyName = useMemo(() => {
    const map = new Map(properties.map((p) => [p.id, p.name]));
    return (id: string | null | undefined) =>
      id == null ? "—" : (map.get(id) ?? id);
  }, [properties]);

  // ── Ledger entries query (All entries tab) ───────────────────────────────────
  const filters: OwnerLedgerFilters = {
    ownerPartyId: ownerFilter || undefined,
    propertyId: propertyFilter || undefined,
    month: monthFilter || undefined,
    direction: (directionFilter as OwnerLedgerDirection) || undefined,
    paidBy: (paidByFilter as OwnerPaidBy) || undefined,
    paymentStatus: (paymentStatusFilter as OwnerPaymentStatus) || undefined,
    category: (categoryFilter as OwnerLedgerCategory) || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const entriesQuery = useOwnerLedgerEntries(filters, { enabled: activeTab === "all-entries" });

  const rows = useMemo(() => entriesQuery.data?.data.rows ?? [], [entriesQuery.data]);
  const total = useMemo(() => entriesQuery.data?.data.total ?? 0, [entriesQuery.data]);
  const hasNextPage = (page + 1) * PAGE_SIZE < total;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function resetToFirstPage() {
    setPage(0);
  }

  // ── Active filter chips ───────────────────────────────────────────────────────
  const activeChips = useMemo<FilterChip[]>(() => {
    const chips: FilterChip[] = [];
    if (ownerFilter) {
      chips.push({
        id: "owner",
        label: `Owner: ${ownerName(ownerFilter)}`,
        onDismiss: () => { setOwnerFilter(""); resetToFirstPage(); },
      });
    }
    if (propertyFilter) {
      const name = properties.find((p) => p.id === propertyFilter)?.name ?? propertyFilter;
      chips.push({
        id: "property",
        label: `Property: ${name}`,
        onDismiss: () => { setPropertyFilter(""); resetToFirstPage(); },
      });
    }
    if (monthFilter) {
      chips.push({
        id: "month",
        label: `Month: ${monthFilter}`,
        onDismiss: () => { setMonthFilter(""); resetToFirstPage(); },
      });
    }
    if (categoryFilter) {
      chips.push({
        id: "category",
        label: `Category: ${labelFor(categoryFilter)}`,
        onDismiss: () => { setCategoryFilter(""); resetToFirstPage(); },
      });
    }
    if (directionFilter) {
      chips.push({
        id: `direction-${directionFilter}`,
        label: `Direction: ${labelFor(directionFilter)}`,
        onDismiss: () => { setDirectionFilter(""); resetToFirstPage(); },
      });
    }
    if (paidByFilter) {
      chips.push({
        id: `paidBy-${paidByFilter}`,
        label: `Paid by: ${labelFor(paidByFilter)}`,
        onDismiss: () => { setPaidByFilter(""); resetToFirstPage(); },
      });
    }
    if (paymentStatusFilter) {
      chips.push({
        id: `paymentStatus-${paymentStatusFilter}`,
        label: `Status: ${labelFor(paymentStatusFilter)}`,
        onDismiss: () => { setPaymentStatusFilter(""); resetToFirstPage(); },
      });
    }
    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerFilter, propertyFilter, monthFilter, categoryFilter, directionFilter, paidByFilter, paymentStatusFilter, owners, properties]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Owner Ledger"
        icon={BookOpen}
        description="Browse owners and manage individual ledger entries."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverlay({
                  kind: "month-review",
                  ownerPartyId: ownerFilter,
                  month: monthFilter || currentMonth(),
                })
              }
            >
              <RefreshCw className="h-4 w-4" /> Month review
            </Button>
            <Button variant="gold" onClick={() => setOverlay({ kind: "new" })}>
              <Plus className="h-4 w-4" /> New entry
            </Button>
          </div>
        }
      />

      {/* Tab switcher */}
      <Segmented<TabValue>
        ariaLabel="Owner ledger view"
        value={activeTab}
        onChange={setActiveTab}
        size="sm"
        className="w-fit"
        options={[
          { value: "owners",      label: "Owners" },
          { value: "units",       label: "Units" },
          { value: "all-entries", label: "All entries" },
        ]}
      />

      {/* ── OWNERS TAB (default — owner-first front door) ────────────────────── */}
      {activeTab === "owners" && <OwnersTab />}

      {/* ── UNITS TAB ───────────────────────────────────────────────────────── */}
      {activeTab === "units" && <UnitsTab />}

      {/* ── ALL ENTRIES TAB ─────────────────────────────────────────────────── */}
      {activeTab === "all-entries" && (
        <>
          {/* Filters ▾ disclosure + active chips */}
          <div className="space-y-3">
            {/* Filters toggle button */}
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                aria-expanded={filtersOpen}
                aria-controls="filters-panel"
                onClick={() => setFiltersOpen((v) => !v)}
              >
                <ChevronDown
                  className={`h-4 w-4 mr-1 transition-transform ${filtersOpen ? "rotate-180" : ""}`}
                />
                Filters
                {activeChips.length > 0 && (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-xs">
                    {activeChips.length}
                  </Badge>
                )}
              </Button>

              {/* Active chips */}
              {activeChips.map((chip) => (
                <span
                  key={chip.id}
                  className="inline-flex items-center gap-1 rounded-full bg-muted/60 border border-border/50 px-2.5 py-1 text-xs font-medium text-foreground"
                >
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Clear filter: ${chip.label}`}
                    onClick={chip.onDismiss}
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>

            {/* Collapsible filter panel */}
            {filtersOpen && (
              <Card
                id="filters-panel"
                className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
              >
                <CardContent className="p-4 flex flex-wrap items-start gap-x-6 gap-y-4">
                  {/* Owner */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Owner
                    </span>
                    <SelectInput
                      aria-label="Owner filter"
                      value={ownerFilter}
                      onChange={(e) => { setOwnerFilter(e.target.value); resetToFirstPage(); }}
                      className="min-h-0 w-52 py-1.5"
                    >
                      <option value="">All owners</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.displayName}
                        </option>
                      ))}
                    </SelectInput>
                  </div>

                  {/* Property */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Property
                    </span>
                    <SelectInput
                      aria-label="Property filter"
                      value={propertyFilter}
                      onChange={(e) => { setPropertyFilter(e.target.value); resetToFirstPage(); }}
                      className="min-h-0 w-52 py-1.5"
                    >
                      <option value="">All properties</option>
                      {properties.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </SelectInput>
                  </div>

                  {/* Month */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Month
                    </span>
                    <TextInput
                      aria-label="Month filter"
                      type="month"
                      value={monthFilter}
                      onChange={(e) => { setMonthFilter(e.target.value); resetToFirstPage(); }}
                      className="min-h-0 w-40 py-1.5"
                    />
                  </div>

                  {/* Category */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Category
                    </span>
                    <SelectInput
                      aria-label="Category filter"
                      value={categoryFilter}
                      onChange={(e) => { setCategoryFilter(e.target.value as OwnerLedgerCategory | ""); resetToFirstPage(); }}
                      className="min-h-0 w-52 py-1.5"
                    >
                      {CATEGORY_SELECT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </SelectInput>
                  </div>

                  {/* Direction pills — single-select */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Direction
                    </span>
                    <PillBar
                      ariaLabel="Direction filter"
                      size="sm"
                      value={directionFilter ? [directionFilter] : []}
                      onChange={(v) => {
                        const next = v.find((x) => x !== directionFilter) ?? "";
                        setDirectionFilter(next as OwnerLedgerDirection | "");
                        resetToFirstPage();
                      }}
                      options={DIRECTION_OPTIONS}
                    />
                  </div>

                  {/* Paid By pills — single-select */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Paid by
                    </span>
                    <PillBar
                      ariaLabel="Paid by filter"
                      size="sm"
                      value={paidByFilter ? [paidByFilter] : []}
                      onChange={(v) => {
                        const next = v.find((x) => x !== paidByFilter) ?? "";
                        setPaidByFilter(next as OwnerPaidBy | "");
                        resetToFirstPage();
                      }}
                      options={PAID_BY_OPTIONS}
                    />
                  </div>

                  {/* Payment Status pills — single-select */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Payment status
                    </span>
                    <PillBar
                      ariaLabel="Payment status filter"
                      size="sm"
                      value={paymentStatusFilter ? [paymentStatusFilter] : []}
                      onChange={(v) => {
                        const next = v.find((x) => x !== paymentStatusFilter) ?? "";
                        setPaymentStatusFilter(next as OwnerPaymentStatus | "");
                        resetToFirstPage();
                      }}
                      options={PAYMENT_STATUS_OPTIONS}
                    />
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Entries table */}
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardContent className="p-0">
              <EnhancedDataTable
                data={rows}
                emptyMessage={
                  entriesQuery.isLoading
                    ? "Loading entries…"
                    : "No ledger entries match these filters."
                }
                columns={[
                  {
                    key: "date",
                    label: "Date",
                    render: (row) => (
                      <span className="tabular-nums text-sm">{formatDate(row.transactionDate)}</span>
                    ),
                  },
                  {
                    key: "owner",
                    label: "Owner / Property",
                    render: (row) => (
                      <div>
                        <div className="font-medium">{ownerName(row.ownerPartyId)}</div>
                        <div className="text-xs text-muted-foreground">{propertyName(row.propertyId)}</div>
                        {row.unitCode && (
                          <div className="text-xs text-muted-foreground">Unit: {row.unitCode}</div>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "direction",
                    label: "Direction",
                    render: (row) => (
                      <StatusPill
                        tone={
                          row.direction === "income"
                            ? "emerald"
                            : row.direction === "payout"
                              ? "sky"
                              : // Informational rows move no money — neutral, never the
                                // amber "expense" tone that would read as a deduction.
                                row.direction === "informational"
                                ? "slate"
                                : "amber"
                        }
                      >
                        {labelFor(row.direction)}
                      </StatusPill>
                    ),
                  },
                  {
                    key: "category",
                    label: "Category",
                    render: (row) => (
                      <span className="text-sm text-muted-foreground">{labelFor(row.category)}</span>
                    ),
                  },
                  {
                    key: "amount",
                    label: "Amount",
                    className: "text-right",
                    render: (row) => (
                      <div className="text-right">
                        <span className="font-semibold tabular-nums">
                          {formatRM(Number(row.amount))}
                        </span>
                        {row.sstAmount && row.sstAmount !== "0" ? (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            + SST {formatRM(Number(row.sstAmount))}
                          </div>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "paidBy",
                    label: "Paid By",
                    render: (row) => <PaidByBadge paidBy={row.paidBy} />,
                  },
                  {
                    key: "paymentStatus",
                    label: "Payment Status",
                    render: (row) => (
                      <StatusPill tone={getStatusTone(row.paymentStatus)}>
                        {labelFor(row.paymentStatus)}
                      </StatusPill>
                    ),
                  },
                  {
                    key: "taxCategory",
                    label: "Tax Category",
                    render: (row) => (
                      <span className="text-xs text-muted-foreground">{labelFor(row.taxCategory)}</span>
                    ),
                  },
                  {
                    key: "actions",
                    label: "",
                    className: "text-right",
                    render: (row) => (
                      <div className="flex items-center justify-end gap-1">
                        {row.status !== "void" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                            aria-label={`Void entry ${row.id}`}
                            onClick={() => setOverlay({ kind: "void", entry: row })}
                          >
                            Void
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </CardContent>
          </Card>

          {/* Pagination */}
          {(page > 0 || hasNextPage) && (
            <div className="flex items-center justify-end gap-3">
              <span className="text-xs text-muted-foreground">
                Page {page + 1}{totalPages > 0 ? ` of ${totalPages}` : ""} &bull; {total} total
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || entriesQuery.isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNextPage || entriesQuery.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── Shared overlays (both tabs) ─────────────────────────────────────── */}

      {/* Entry form drawer — create only (ledger entries are read-only; no edit) */}
      <EntryFormDrawer
        open={overlay?.kind === "new"}
        onClose={() => setOverlay(null)}
        mode="create"
        entry={undefined}
        owners={owners}
      />

      {/* Month review sheet — sync + summary + entries */}
      <MonthReviewSheet
        open={overlay?.kind === "month-review"}
        onClose={() => setOverlay(null)}
        initialOwnerPartyId={overlay?.kind === "month-review" ? overlay.ownerPartyId : ""}
        initialMonth={overlay?.kind === "month-review" ? overlay.month : ""}
      />

      {/* Void confirm — ConfirmAlert destructive, calls useVoidLedgerEntry */}
      <ConfirmAlert
        open={overlay?.kind === "void"}
        onCancel={() => setOverlay(null)}
        onConfirm={() => {
          if (overlay?.kind !== "void") return;
          const entry = overlay.entry;
          setOverlay(null);
          voidEntry.mutate(
            { id: entry.id, expectedUpdatedAt: entry.updatedAt },
            {
              onSuccess: () => toast.success("Ledger entry voided."),
              onError: (err) => {
                if (err.message.includes("409") || err.message.toLowerCase().includes("conflict")) {
                  toast.error("Entry was updated elsewhere. Please review the latest data.");
                } else {
                  toast.error(err.message);
                }
              },
            },
          );
        }}
        title="Void this ledger entry?"
        body={
          overlay?.kind === "void"
            ? `${ownerName(overlay.entry.ownerPartyId)} — ${overlay.entry.statementMonth.slice(0, 7)} · ${formatRM(Number(overlay.entry.amount))}. Voiding cannot be undone.`
            : ""
        }
        confirmLabel="Void entry"
        destructive
      />
    </div>
  );
}
