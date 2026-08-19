// Owner Workspace — drill-in page for a single owner's ledger (M6b / T3).
//
// Route: /tenancy/owner-ledger/:ownerPartyId (flag-gated ENABLE_PHASE2_OWNER_BILLING).
//
// Shows:
//   • ‹ Back to owners breadcrumb + owner name heading.
//   • Defaults to ALL-TIME (no date forced). "Date range ▾" toggle (collapsed
//     by default) opens optional From/To pickers; when set, totals scope to that
//     range and a dismissible chip appears.
//   • 3 summary GlowCards: Gross / Total Expenses / Net Payout (highlighted).
//   • Balance panel: Brought Forward → Net this month → Payouts → Carried Forward.
//     Carried-forward shows in rose when negative (KAEN fronted), emerald when positive.
//   • Record Payout action button → RecordPayoutDrawer → useCreateLedgerEntry.
//   • Entries grouped by statementMonth DESC, each group collapsible with a
//     per-month net subtotal.
//   • Table with 5 default columns (Date · Unit · Category · Amount · Paid-By)
//     + hidden extras (SST · Status · Tax Category · Description) revealed
//     by a "Columns ▾" toggle.
//   • Row click → EntryFormDrawer in read-only detail mode.
//   • Void button → ConfirmAlert → useVoidLedgerEntry.
//   • "New entry" + "Month review" action buttons (reuse drawer + MonthReviewSheet).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronRight,
  Columns3,
  DollarSign,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  SendHorizonal,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { PageHeader, StatusPill } from "@/components/ui";
import { Field, TextInput } from "@/components/form-ui";
import { PaidByBadge } from "@/components/paid-by-badge";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { cn } from "@/lib/utils";
import { apiFetch, ApiError } from "@/lib/api-client";
import { currentMonth } from "@/lib/date-utils";
import { labelFor } from "@/lib/string-utils";
import {
  useOwnerLedgerEntries,
  useOwnerLedgerSummary,
  useUnitsSummary,
  useCreateLedgerEntry,
  useVoidLedgerEntry,
  downloadLedgerReceipt,
  type OwnerLedgerEntryRow,
  type OwnerLedgerSummary,
} from "@/api/owner-ledger";
import { FormDrawer } from "@/components/ui/form-drawer";
import { EntryFormDrawer } from "./entry-form-drawer";
import { MonthReviewSheet } from "./month-review-sheet";
import { UnitSummaryCard } from "./unit-summary-card";
import { MultiMonthDownload, type MultiMonthDownloadParams } from "./multi-month-download";
import { downloadMonthRangeZip } from "@/api/owner-billing";
import { ownerLedgerRowStatus, groupByDirection } from "./ledger-presentation";
import { VoidChargeDialog } from "@/components/void-charge-dialog";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract YYYY-MM from an ISO date (statementMonth is often "2026-06-01T00:00:00Z"). */
function toMonthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Human-friendly month label from YYYY-MM or ISO date. */
function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.slice(0, 7).split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleString("en-MY", { month: "long", year: "numeric" });
}

// ─── Balance panel ────────────────────────────────────────────────────────────

/** Brought Forward → Net this month → Payouts → Carried Forward rows. */
function BalancePanel({
  summary,
  isLoading,
}: {
  summary: OwnerLedgerSummary | undefined;
  isLoading: boolean;
}) {
  const broughtForward = Number(summary?.broughtForward ?? 0);
  const netThisPeriod = Number(summary?.netThisPeriod ?? 0);
  const depositCollected = Number(summary?.depositCollected ?? 0);
  const payoutsTotal = Number(summary?.payoutsTotal ?? 0);
  const carriedForward = Number(summary?.carriedForward ?? 0);

  function fmtRow(label: string, value: number, highlight?: "emerald" | "rose") {
    const color =
      highlight === "emerald"
        ? "text-emerald-500"
        : highlight === "rose"
          ? "text-rose-400"
          : "text-foreground";
    return (
      <div className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={`text-sm font-semibold tabular-nums ${color}`}>
          {isLoading ? "—" : formatRM(value)}
        </span>
      </div>
    );
  }

  const cfColor: "emerald" | "rose" =
    carriedForward >= 0 ? "emerald" : "rose";

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardContent className="p-4 space-y-0">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Running Balance
        </p>
        {fmtRow("Brought Forward", broughtForward)}
        {fmtRow("Net this period", netThisPeriod)}
        {depositCollected > 0 && !isLoading && (
          <p className="text-xs text-muted-foreground -mt-1 mb-1 text-right">
            incl. {formatRM(depositCollected)} deposit collected (non-income)
          </p>
        )}
        {fmtRow("Payouts recorded", -Math.abs(payoutsTotal))}
        <div className="flex items-center justify-between pt-2">
          <span className="text-sm font-bold text-foreground">Carried Forward</span>
          <span
            data-testid="carried-forward-value"
            className={`text-base font-bold tabular-nums ${
              cfColor === "rose" ? "text-rose-400" : "text-emerald-500"
            }`}
          >
            {isLoading ? "—" : formatRM(carriedForward)}
          </span>
        </div>
        {carriedForward < 0 && !isLoading && (
          <p className="text-xs text-rose-400 mt-1">
            KAEN has fronted {formatRM(Math.abs(carriedForward))} — rolls to next month.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Payout history panel (#8) ─────────────────────────────────────────────────

/**
 * Itemized list of recorded payouts (money remitted to the owner). Lives in the
 * parent OwnerWorkspace scope as a sibling of BalancePanel so it is visible on
 * every tab. Populated by filtering the already-fetched allEntries to
 * direction==="payout" — voided rows INCLUDED (with a "Voided" badge + struck
 * amount) so a reversal stays auditable. Each active row exposes a Void action
 * that reuses the existing void overlay/confirm path (no new endpoint).
 */
function PayoutHistoryPanel({
  payouts,
  onVoid,
}: {
  payouts: OwnerLedgerEntryRow[];
  onVoid: (entry: OwnerLedgerEntryRow) => void;
}) {
  if (payouts.length === 0) return null;
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Payout history
        </p>
        <ul className="divide-y divide-border/30">
          {payouts.map((p) => {
            const voided = p.status === "void";
            return (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm tabular-nums text-foreground">
                      {formatDate(p.transactionDate)}
                    </span>
                    {voided && (
                      <Badge variant="outline" className="text-muted-foreground">
                        Voided
                      </Badge>
                    )}
                  </div>
                  {p.remarks && (
                    <p className="text-xs text-muted-foreground truncate">{p.remarks}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      voided ? "text-muted-foreground line-through" : "text-sky-500",
                    )}
                  >
                    {formatRM(Number(p.amount))}
                  </span>
                  {!voided && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                      aria-label={`Void payout ${p.id}`}
                      onClick={() => onVoid(p)}
                    >
                      Void
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ─── Record Payout drawer ─────────────────────────────────────────────────────

type PayoutFormState = {
  amount: string;
  transactionDate: string;
  method: string;
};

type PayoutFormErrors = Partial<Record<"amount" | "transactionDate", string>>;

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function RecordPayoutDrawer({
  open,
  onClose,
  ownerPartyId,
  defaultPropertyId,
  carriedForward,
}: {
  open: boolean;
  onClose: () => void;
  ownerPartyId: string;
  defaultPropertyId: string;
  carriedForward: number;
}) {
  const createEntry = useCreateLedgerEntry();

  const defaultAmount =
    carriedForward > 0 ? carriedForward.toFixed(2) : "0.00";

  const [form, setForm] = useState<PayoutFormState>({
    amount: defaultAmount,
    transactionDate: todayDate(),
    method: "",
  });
  const [errors, setErrors] = useState<PayoutFormErrors>({});

  // Re-seed amount whenever the drawer opens or carriedForward changes so the
  // field always prefills the current positive balance (not a stale prior payout).
  useEffect(() => {
    if (open) {
      const seedAmount = carriedForward > 0 ? carriedForward.toFixed(2) : "0.00";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setForm({ amount: seedAmount, transactionDate: todayDate(), method: "" });
      setErrors({});
    }
  }, [open, carriedForward]);

  function set<K extends keyof PayoutFormState>(key: K, value: PayoutFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key as keyof PayoutFormErrors];
      return next;
    });
  }

  function handleSubmit() {
    const errs: PayoutFormErrors = {};
    if (!DECIMAL_RE.test(form.amount) || Number(form.amount) <= 0) {
      errs.amount = "Enter a positive amount (max 2 dp).";
    }
    if (!form.transactionDate) errs.transactionDate = "Date is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const remarks = form.method.trim() || null;
    const statementMonth = form.transactionDate.slice(0, 7);

    createEntry.mutate(
      {
        ownerPartyId,
        propertyId: defaultPropertyId,
        direction: "payout",
        category: "owner_payout",
        paidBy: "kaen",
        amount: form.amount,
        transactionDate: form.transactionDate,
        statementMonth,
        remarks,
        paymentStatus: "paid",
        taxCategory: "not_applicable",
      },
      {
        onSuccess: () => {
          toast.success("Payout recorded.");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Record Payout"
      description="Record a cash remittance from KAEN to this owner. Reduces the carried-forward balance."
      onSubmit={handleSubmit}
      submit={{
        label: "Record payout",
        pendingLabel: "Recording…",
        pending: createEntry.isPending,
        icon: SendHorizonal,
      }}
    >
      <div className="space-y-4">
        <Field label="Amount (RM)" error={errors.amount}>
          <TextInput
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => set("amount", e.target.value)}
            aria-label="Payout amount"
          />
        </Field>

        <Field label="Payout date" error={errors.transactionDate}>
          <TextInput
            type="date"
            value={form.transactionDate}
            onChange={(e) => set("transactionDate", e.target.value)}
            aria-label="Payout date"
          />
        </Field>

        <Field label="Method / bank (optional)">
          <TextInput
            placeholder="e.g. Maybank transfer"
            value={form.method}
            onChange={(e) => set("method", e.target.value)}
            aria-label="Payment method"
          />
        </Field>
      </div>
    </FormDrawer>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type WorkspaceTab = "statements" | "entries";

type OverlayState =
  | { kind: "new" }
  | { kind: "view"; entry: OwnerLedgerEntryRow }
  | { kind: "void"; entry: OwnerLedgerEntryRow }
  | { kind: "month-review"; ownerPartyId: string; month: string }
  | { kind: "payout" }
  // A ledger row derived from a posted Charge (entry.sourceChargeId set) —
  // resolves via GET /billing/charges/:chargeId below and feeds the reused
  // VoidChargeDialog (mirrors unit-workspace.tsx).
  | { kind: "void-charge-entry"; chargeId: string }
  | null;

/**
 * Admin wrapper around the shared MultiMonthDownload picker — wires the owner-scoped
 * admin export route (carrying THIS workspace's ownerPartyId). Owns the in-flight
 * state + error toast; the picker itself stays presentational + ownerPartyId-free.
 */
function WorkspaceStatementExport({ ownerPartyId }: { ownerPartyId: string }) {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(params: MultiMonthDownloadParams) {
    setDownloading(true);
    try {
      await downloadMonthRangeZip({ ownerPartyId, ...params });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the statements.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <MultiMonthDownload
      onDownload={handleDownload}
      downloading={downloading}
      description="Bundle every posted statement for this owner in a date range into one ZIP."
    />
  );
}

// ─── Entries table (one direction group: Income / Expenses / Payouts) ─────────

/**
 * One direction-grouped sub-table for the All-Entries tab's per-month card.
 * Reused for Income, Expenses, and Payouts (owner-ledger view clarity, Task 4)
 * so groupByDirection's Income/Expenses split and the pre-existing Payouts
 * carve-out render through identical markup.
 *
 * `resolveStatus` is injected per-caller rather than hardcoded to
 * ownerLedgerRowStatus: Income/Expenses use the shared helper, but Payouts
 * deliberately keeps the ORIGINAL getStatusTone(paymentStatus) resolution —
 * ownerLedgerRowStatus's non-income branch reads includeInPayout (false for
 * a payout row, same as an owner-paid expense) and would mislabel a payout
 * "Owner-paid", which is wrong. A payout was never meant to reach that
 * helper (see ledger-presentation.test.ts's own comment on this exact point);
 * Payouts also stay a THIRD section here rather than being dropped the way
 * groupByDirection drops them elsewhere, because this exact table is
 * covered by an existing test ("payout row not colored as income in the
 * All-Entries table") that requires payout rows to keep rendering, sky-toned,
 * in this view — separate from (and in addition to) the always-visible
 * PayoutHistoryPanel above the tabs.
 */
function EntriesSectionTable({
  entries,
  showExtraColumns,
  monthKey,
  resolveStatus,
  onRowClick,
  onVoid,
}: {
  entries: OwnerLedgerEntryRow[];
  showExtraColumns: boolean;
  monthKey: string;
  resolveStatus: (entry: OwnerLedgerEntryRow) => ReturnType<typeof ownerLedgerRowStatus>;
  onRowClick: (entry: OwnerLedgerEntryRow) => void;
  onVoid: (entry: OwnerLedgerEntryRow) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="min-w-full border-collapse text-left text-sm"
        role="table"
        aria-label={`Entries for ${monthLabel(monthKey)}`}
      >
        <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
          <tr>
            {/* 5 essential columns */}
            <th className="px-4 py-3 font-semibold">Date</th>
            <th className="px-4 py-3 font-semibold">Unit</th>
            <th className="px-4 py-3 font-semibold">Category</th>
            <th className="px-4 py-3 font-semibold text-right">Amount</th>
            <th className="px-4 py-3 font-semibold">Paid By</th>
            {/* Extra columns (hidden by default) */}
            {showExtraColumns && (
              <>
                <th className="px-4 py-3 font-semibold text-right">SST</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Tax Category</th>
                <th className="px-4 py-3 font-semibold">Description</th>
              </>
            )}
            {/* Actions column */}
            <th className="px-4 py-3 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const st = resolveStatus(entry);
            return (
              <tr
                key={entry.id}
                role="row"
                aria-label={`Entry ${entry.id}`}
                className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)] cursor-pointer"
                onClick={() => onRowClick(entry)}
              >
                {/* Date */}
                <td className="px-4 py-3.5 text-sm text-[var(--text-primary)] whitespace-nowrap">
                  <span className="tabular-nums">
                    {formatDate(entry.transactionDate)}
                  </span>
                </td>
                {/* Unit */}
                <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                  {entry.unitCode ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                {/* Category */}
                <td className="px-4 py-3.5 text-sm text-muted-foreground">
                  {labelFor(entry.category)}
                </td>
                {/* Amount — right-aligned tabular */}
                <td className="px-4 py-3.5 text-sm text-right">
                  <span
                    className={`font-semibold tabular-nums ${
                      entry.direction === "expense"
                        ? "text-rose-400"
                        : entry.direction === "payout"
                          ? "text-sky-500"
                          : "text-emerald-500"
                    }`}
                  >
                    {entry.direction === "expense" && (
                      <Minus className="h-3 w-3 inline mr-0.5" />
                    )}
                    {formatRM(Number(entry.amount))}
                  </span>
                </td>
                {/* Paid By */}
                <td className="px-4 py-3.5">
                  <PaidByBadge paidBy={entry.paidBy} />
                </td>
                {/* Extra columns */}
                {showExtraColumns && (
                  <>
                    {/* SST */}
                    <td className="px-4 py-3.5 text-sm text-right tabular-nums text-muted-foreground">
                      {entry.sstAmount && entry.sstAmount !== "0"
                        ? formatRM(Number(entry.sstAmount))
                        : "—"}
                    </td>
                    {/* Payment Status */}
                    <td className="px-4 py-3.5">
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    </td>
                    {/* Tax Category */}
                    <td className="px-4 py-3.5 text-xs text-muted-foreground">
                      {labelFor(entry.taxCategory)}
                    </td>
                    {/* Description */}
                    <td className="px-4 py-3.5 text-sm text-muted-foreground max-w-xs truncate">
                      {entry.description ?? "—"}
                    </td>
                  </>
                )}
                {/* Row actions — stop propagation so row-click (edit) doesn't also fire */}
                <td
                  className="px-4 py-3.5 text-right whitespace-nowrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  {entry.status !== "void" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                      aria-label={`Void entry ${entry.id}`}
                      onClick={() => onVoid(entry)}
                    >
                      Void
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OwnerWorkspacePage() {
  const { ownerPartyId = "" } = useParams<{ ownerPartyId: string }>();
  const navigate = useNavigate();

  // ── Tab state — "statements" is the primary (default) tab ───────────────────
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("statements");

  // ── Date range (optional; default = all-time, no months sent) ───────────────
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");

  // Only forward months to hooks when the user has activated and set the range.
  const activeFrom = dateRangeOpen && fromMonth ? fromMonth : undefined;
  const activeTo = dateRangeOpen && toMonth ? toMonth : undefined;

  // ── Collapsible month sections ───────────────────────────────────────────────
  // Collapsed by key = "YYYY-MM"; default all expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ── Extra-columns toggle ─────────────────────────────────────────────────────
  const [showExtraColumns, setShowExtraColumns] = useState(false);

  // ── Monthly Statements tab — month picker (Task 8 / D3) ──────────────────────
  // statementMonth drives useUnitsSummary → the combined "All units" card + one
  // UnitSummaryCard per unit. Defaults to the current billing month.
  const [statementMonth, setStatementMonth] = useState<string>(currentMonth);
  // Combined-scope invoice ("Print Invoice (all units)") in-flight state. Each
  // UnitSummaryCard owns its own per-unit invoice state independently.
  const [downloadingCombined, setDownloadingCombined] = useState(false);

  async function handlePrintCombined() {
    if (!statementMonth) return;
    setDownloadingCombined(true);
    try {
      // apartmentId omitted → owner-level (all units combined) receipt.
      await downloadLedgerReceipt(ownerPartyId, statementMonth);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the invoice.");
    } finally {
      setDownloadingCombined(false);
    }
  }

  // ── Overlays ─────────────────────────────────────────────────────────────────
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const voidEntry = useVoidLedgerEntry();
  const queryClient = useQueryClient();

  // Route a ledger-row Void by its source (void integrity) — mirrors
  // unit-workspace.tsx so every section (Income / Expenses / Payouts + the
  // payout-history panel) behaves identically:
  //   charge-derived (sourceChargeId) → the real money+document void via the
  //     reused VoidChargeDialog (never the shallow entry void; the backend now
  //     409s a shallow void of a synced row as VOID_AT_SOURCE);
  //   bill-derived (sourceUtilityBillId) → point the admin at the utility
  //     bill's own void path (no mutation here);
  //   manual/payout (no source ids) → the unchanged shallow overlay.
  const voidChargeEntryId = overlay?.kind === "void-charge-entry" ? overlay.chargeId : null;
  const voidChargeEntryQuery = useQuery({
    queryKey: ["billing-charge", voidChargeEntryId],
    queryFn: () =>
      apiFetch<{ id: string; chargeNumber: string; status: string }>(
        `/billing/charges/${voidChargeEntryId}`,
      ),
    enabled: voidChargeEntryId !== null,
  });
  // Owner-workspace has no document-void path (unlike unit-workspace), so the
  // dialog's target is simply the resolved charge for the picked row.
  const voidChargeTarget = voidChargeEntryId ? (voidChargeEntryQuery.data ?? null) : null;

  const handleVoidEntry = (entry: OwnerLedgerEntryRow) => {
    if (entry.sourceChargeId) {
      setOverlay({ kind: "void-charge-entry", chargeId: entry.sourceChargeId });
    } else if (entry.sourceUtilityBillId) {
      toast.info(
        `This entry is linked to a utility bill (${labelFor(entry.category)}) — void it from the bill, not here.`,
      );
    } else {
      setOverlay({ kind: "void", entry });
    }
  };

  // Fail-loud on a broken charge fetch (mirrors unit-workspace.tsx): a 404
  // means the sync desynced (the charge this row pointed to is gone) — say so;
  // any other error gets a generic retry prompt. Either way the dialog must
  // not silently never open after the admin clicked Void on a money row.
  useEffect(() => {
    if (!voidChargeEntryId) return;
    if (voidChargeEntryQuery.isError) {
      const err = voidChargeEntryQuery.error;
      if (err instanceof ApiError && err.status === 404) {
        toast.error("This entry has no linked charge to void.");
      } else {
        toast.error("Could not load the linked charge — please retry.");
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a query-result transition (error) with a toast + overlay-close; there is no non-effect place to observe this async settle.
      setOverlay(null);
    }
  }, [voidChargeEntryId, voidChargeEntryQuery.isError, voidChargeEntryQuery.error]);

  // ── Owner name (from /parties/owners) ────────────────────────────────────────
  const ownersQuery = useQuery({
    queryKey: ["owners"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>("/parties/owners"),
  });
  const owners = useMemo(() => ownersQuery.data?.data ?? [], [ownersQuery.data]);
  const resolvedOwnerName = useMemo(() => {
    const found = owners.find((o) => o.id === ownerPartyId);
    return found?.displayName ?? ownerPartyId;
  }, [owners, ownerPartyId]);

  // ── Summary ──────────────────────────────────────────────────────────────────
  const summaryQuery = useOwnerLedgerSummary({
    ownerPartyId,
    fromMonth: activeFrom,
    toMonth: activeTo,
  });
  const summary = summaryQuery.data?.data;

  // ── Units summary (Task 5) — per-unit + combined payout for the picked month.
  // Drives the Monthly Statements tab cards. Disabled until a month is set
  // (statementMonth defaults to the current month, so it's effectively always on).
  const unitsSummaryQuery = useUnitsSummary(ownerPartyId, statementMonth);
  const unitsSummary = unitsSummaryQuery.data?.data;

  // ── Entries (grouped client-side; the list API caps `limit` at 100) ───────────
  const entriesQuery = useOwnerLedgerEntries(
    { ownerPartyId, fromMonth: activeFrom, toMonth: activeTo, limit: 100 },
    { enabled: !!ownerPartyId },
  );
  const allEntries = useMemo(
    () => entriesQuery.data?.data.rows ?? [],
    [entriesQuery.data],
  );

  const totalEntries = entriesQuery.data?.data.total ?? 0;

  // ── First propertyId for the payout drawer ───────────────────────────────────
  // The Record Payout create call requires a propertyId; we pick the first property
  // found in any active entry as a sensible default.
  const firstPropertyId = useMemo(() => {
    return allEntries.find((e) => e.propertyId)?.propertyId ?? "";
  }, [allEntries]);

  // ── Payouts (#8) — itemized for the Payout-history panel ─────────────────────
  // Filter the already-fetched entries to direction:"payout". Voided rows are
  // INCLUDED (the panel renders them struck-through) so a reversal stays visible.
  // Sorted newest-first by transactionDate.
  const payoutEntries = useMemo(
    () =>
      allEntries
        .filter((e) => e.direction === "payout")
        // Newest-first by transactionDate, tie-broken by createdAt desc then id
        // so same-date payouts have a stable, deterministic order (not left to
        // the upstream fetch order + JS stable-sort).
        .sort((a, b) => {
          const byDate = b.transactionDate.localeCompare(a.transactionDate);
          if (byDate !== 0) return byDate;
          const byCreated = b.createdAt.localeCompare(a.createdAt);
          if (byCreated !== 0) return byCreated;
          return b.id.localeCompare(a.id);
        }),
    [allEntries],
  );

  // ── Group entries by statementMonth DESC ─────────────────────────────────────
  const monthGroups = useMemo(() => {
    const map = new Map<string, OwnerLedgerEntryRow[]>();
    // Exclude voided entries from the workspace month-groups (they still appear
    // in the "All entries" tab on the ledger index page).
    const activeEntries = allEntries.filter((e) => e.status !== "void");
    for (const entry of activeEntries) {
      const key = toMonthKey(entry.statementMonth);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    }
    // Sort DESC by month key
    const sorted = Array.from(map.entries()).sort(([a], [b]) =>
      b.localeCompare(a),
    );
    return sorted.map(([monthKey, entries]) => {
      // Per-month net subtotal: income adds, expense deducts, payout is excluded.
      // Include sstAmount to match the GlowCard totals from summarizeOwnerPeriod.
      const subtotal = entries.reduce((acc, e) => {
        const amt = Number(e.amount) + (e.sstAmount ? Number(e.sstAmount) : 0);
        if (e.direction === "expense") return acc - amt;
        if (e.direction === "income") return acc + amt;
        return acc; // ignore payout in per-month subtotal
      }, 0);
      return { monthKey, entries, subtotal };
    });
  }, [allEntries]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const isLoading = entriesQuery.isLoading || summaryQuery.isLoading;
  // isEmpty is based on monthGroups (which excludes voided entries), so an owner
  // with only voided entries in range correctly shows the empty state.
  const isEmpty = !isLoading && monthGroups.length === 0;

  return (
    <div className="space-y-6">
      {/* Back crumb */}
      <div>
        <Link
          to="/tenancy/owner-ledger"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to owners
        </Link>
      </div>

      {/* Page header */}
      <PageHeader
        title={resolvedOwnerName || "Owner Workspace"}
        icon={BookOpen}
        description="Owner ledger entries grouped by month."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setOverlay({
                  kind: "month-review",
                  ownerPartyId,
                  month: toMonth || currentMonth(),
                })
              }
            >
              <RefreshCw className="h-4 w-4" /> Month review
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOverlay({ kind: "payout" })}
              data-testid="record-payout-btn"
              disabled={!firstPropertyId}
              title={!firstPropertyId ? "No property to attribute the payout to" : undefined}
            >
              <SendHorizonal className="h-4 w-4" /> Record payout
            </Button>
            <Button
              variant="gold"
              onClick={() => setOverlay({ kind: "new" })}
            >
              <Plus className="h-4 w-4" /> New entry
            </Button>
          </div>
        }
      />

      {/* Optional date range (default = all-time) */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Toggle */}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={dateRangeOpen}
            aria-controls="workspace-date-range-panel"
            onClick={() => {
              setDateRangeOpen((v) => !v);
              if (dateRangeOpen) {
                setFromMonth("");
                setToMonth("");
              }
            }}
          >
            <Calendar className="h-4 w-4 mr-1" />
            Date range
            <ChevronDown
              className={`h-3.5 w-3.5 ml-1 transition-transform ${dateRangeOpen ? "rotate-180" : ""}`}
            />
          </Button>

          {/* Dismissible chip — renders whenever at least one month is set */}
          {dateRangeOpen && (fromMonth || toMonth) ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 border border-border/50 px-2.5 py-1 text-xs font-medium text-foreground">
              {fromMonth && toMonth
                ? `${fromMonth} – ${toMonth}`
                : fromMonth
                  ? `From ${fromMonth}`
                  : `Until ${toMonth}`}
              <button
                type="button"
                aria-label="Clear date range"
                onClick={() => {
                  setFromMonth("");
                  setToMonth("");
                  setDateRangeOpen(false);
                }}
                className="ml-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>

        {/* Collapsible pickers */}
        {dateRangeOpen && (
          <Card
            id="workspace-date-range-panel"
            className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
          >
            <CardContent className="p-4 flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                  From
                </span>
                <TextInput
                  aria-label="From month"
                  type="month"
                  value={fromMonth}
                  onChange={(e) => setFromMonth(e.target.value)}
                  className="min-h-0 w-36 py-1.5"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                  To
                </span>
                <TextInput
                  aria-label="To month"
                  type="month"
                  value={toMonth}
                  onChange={(e) => setToMonth(e.target.value)}
                  className="min-h-0 w-36 py-1.5"
                />
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Summary GlowCards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Gross */}
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Gross Rental</p>
              <p className="text-3xl font-bold text-foreground tabular-nums">
                {summaryQuery.isLoading
                  ? "—"
                  : formatRM(Number(summary?.grossRental ?? 0))}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                <span>Total income in range</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <TrendingUp className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>

        {/* Total Expenses */}
        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total Expenses</p>
              <p className="text-3xl font-bold text-foreground tabular-nums">
                {summaryQuery.isLoading
                  ? "—"
                  : formatRM(Number(summary?.totalExpenses ?? 0))}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <TrendingDown className="h-3 w-3" />
                <span>Deducted from payout</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <TrendingDown className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>

        {/* Net Payout — highlighted */}
        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Net Payout</p>
              <p className="text-3xl font-bold text-amber-500 tabular-nums">
                {summaryQuery.isLoading
                  ? "—"
                  : formatRM(Number(summary?.netPayoutToOwner ?? 0))}
              </p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                <span>Owner receives</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <DollarSign className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      {/* Balance panel — Brought Forward / Net / Payouts / Carried Forward */}
      <BalancePanel summary={summary} isLoading={summaryQuery.isLoading} />

      {/* Payout history (#8) — itemized recorded payouts + void affordance.
          Sibling of BalancePanel so it stays visible on every tab. Void reuses
          the existing overlay/confirm → useVoidLedgerEntry path. */}
      <PayoutHistoryPanel
        payouts={payoutEntries}
        onVoid={handleVoidEntry}
      />

      {/* ── Tab strip — Monthly Statements (primary) / All Entries (secondary) ── */}
      <div className="border-b border-border/50">
        <nav className="flex gap-1" aria-label="Owner workspace views" role="tablist">
          {(
            [
              { id: "statements", label: "Monthly Statements" },
              { id: "entries", label: "All Entries" },
            ] as const
          ).map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                  isActive
                    ? "text-primary border-primary"
                    : "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* ── Monthly Statements tab (Task 8 / D3) ────────────────────────────────
          Month-first: pick a billing month → useUnitsSummary returns the combined
          payout + a per-unit breakdown (both from the real computeOwnerPayout, so
          every figure foots and agrees with the statement). We render the combined
          "All units" headline card + one UnitSummaryCard per unit. */}
      {activeTab === "statements" && (
        <>
          {/* Month picker — drives the cards below. */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
              Month
            </span>
            <TextInput
              aria-label="Statement month"
              type="month"
              value={statementMonth}
              onChange={(e) => setStatementMonth(e.target.value)}
              className="min-h-0 w-44 py-1.5"
            />
          </div>

          {unitsSummaryQuery.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-52 bg-muted rounded-xl" />
              ))}
            </div>
          ) : !unitsSummary?.combined ? (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardContent className="p-10 text-center">
                <BookOpen className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="text-sm text-muted-foreground">
                  No billing data for {monthLabel(statementMonth)}. Post charges for this
                  month to see per-unit payouts here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Combined "All units" headline card */}
              <GlowCard
                glowColor="gold"
                className="p-6 bg-background/40 backdrop-blur-xl border border-amber-500/30"
              >
                <div className="space-y-4">
                  {/* Clickable region: heading + figures + cue.
                      Navigates to the combined owner statement for this month. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      navigate(
                        `/tenancy/owners/${ownerPartyId}/statements/${statementMonth}`,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(
                          `/tenancy/owners/${ownerPartyId}/statements/${statementMonth}`,
                        );
                      }
                    }}
                    aria-label="View full statement · all units"
                    className="cursor-pointer space-y-4 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-lg bg-amber-500/10 p-1.5">
                        <DollarSign className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      </span>
                      <p className="text-sm font-semibold text-foreground">All units</p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <TrendingUp className="h-3 w-3" />
                          <span>Income Collected</span>
                        </div>
                        <p className="text-sm font-semibold text-foreground tabular-nums">
                          {formatRM(Number(unitsSummary.combined.incomeCollected))}
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <DollarSign className="h-3 w-3" />
                          <span>Deposit Collected</span>
                        </div>
                        <p className="text-sm font-semibold text-foreground tabular-nums">
                          {formatRM(Number(unitsSummary.combined.depositCollected))}
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <TrendingDown className="h-3 w-3" />
                          <span>Deductible Expenses</span>
                        </div>
                        <p className="text-sm font-semibold text-rose-600 dark:text-rose-400 tabular-nums">
                          {formatRM(Number(unitsSummary.combined.deductibleExpenses))}
                        </p>
                      </div>
                      <div className="flex items-center justify-between border-t border-border/30 pt-2">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                          <DollarSign className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                          <span>Net Payout</span>
                        </div>
                        <p
                          className={`text-base font-bold tabular-nums ${
                            Number(unitsSummary.combined.netPayout) < 0
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {formatRM(Number(unitsSummary.combined.netPayout))}
                        </p>
                      </div>
                    </div>

                    {/* "View full statement →" cue */}
                    <p className="text-right text-xs text-amber-600 dark:text-amber-400">
                      View full statement →
                    </p>
                  </div>

                  {/* Print receipt — sibling to the clickable region, NOT nested inside it,
                      so clicks here do not trigger card-body navigation. */}
                  <div className="pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={!statementMonth || downloadingCombined}
                      onClick={handlePrintCombined}
                      title="Download an itemized invoice PDF (with bills) for all units this month"
                    >
                      <Printer className="h-4 w-4" />
                      {downloadingCombined ? "Downloading…" : "Print Invoice (all units)"}
                    </Button>
                  </div>
                </div>
              </GlowCard>

              {/* One card per unit (incl. the property-level sentinel, which renders
                  figures only). */}
              {unitsSummary.units.map((unit) => (
                <UnitSummaryCard
                  key={unit.apartmentId ?? "__unassigned__"}
                  unit={unit}
                  ownerPartyId={ownerPartyId}
                  month={statementMonth}
                />
              ))}
            </div>
          )}

          {/* Multi-month export (D2) — bundle a range of posted statements into one ZIP. */}
          <WorkspaceStatementExport ownerPartyId={ownerPartyId} />
        </>
      )}

      {/* ── All Entries tab ───────────────────────────────────────────────────── */}
      {activeTab === "entries" && (
        <>
          {/* Columns toggle */}
          <div className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={showExtraColumns}
              onClick={() => setShowExtraColumns((v) => !v)}
            >
              <Columns3 className="h-4 w-4" />
              Columns
              <ChevronDown
                className={`h-3.5 w-3.5 ml-0.5 transition-transform ${showExtraColumns ? "rotate-180" : ""}`}
              />
            </Button>
          </div>

          {/* Truncation notice — shown when DB has more than the 100-entry cap */}
          {!isLoading && totalEntries > allEntries.length && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400">
              Showing the latest {allEntries.length} of {totalEntries} entries — narrow with a date range to see earlier records.
            </div>
          )}

          {/* Month-grouped entries */}
          {isLoading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-10 bg-muted rounded-lg w-40" />
          <div className="h-48 bg-muted rounded-xl" />
        </div>
      ) : isEmpty ? (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-10 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              No ledger entries for this owner in the selected range.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {monthGroups.map(({ monthKey, entries, subtotal }) => {
            const isCollapsed = collapsed[monthKey] ?? false;
            // Income/Expenses split (owner-ledger view clarity, Task 4).
            // Payouts are carved out separately (NOT dropped) — see
            // EntriesSectionTable's docstring for why.
            const { income, expenses } = groupByDirection(entries);
            const payouts = entries.filter((e) => e.direction === "payout");
            return (
              <Card
                key={monthKey}
                className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden"
              >
                {/* Month section header — collapsible */}
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  className="w-full flex items-center justify-between px-4 py-3 border-b border-border/50 bg-background/40 hover:bg-background/60 transition-colors text-left"
                  onClick={() =>
                    setCollapsed((prev) => ({
                      ...prev,
                      [monthKey]: !isCollapsed,
                    }))
                  }
                >
                  <div className="flex items-center gap-3">
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-sm font-semibold text-foreground">
                      {monthLabel(monthKey)}
                    </span>
                    <Badge variant="secondary" className="text-xs">
                      {entries.length} {entries.length === 1 ? "entry" : "entries"}
                    </Badge>
                  </div>
                  {/* Per-month net subtotal */}
                  <div className="flex items-center gap-1.5 text-sm font-bold tabular-nums">
                    {subtotal >= 0 ? (
                      <span className="text-emerald-500">{formatRM(subtotal)}</span>
                    ) : (
                      <span className="text-rose-400">{formatRM(subtotal)}</span>
                    )}
                    <span className="text-xs font-normal text-muted-foreground">net</span>
                  </div>
                </button>

                {/* Entries — Income / Expenses / Payouts (owner-ledger view
                    clarity, Task 4). Each section hidden when its group is
                    empty; a Callout precedes Expenses explaining the
                    share-vs-net relationship. */}
                {!isCollapsed && (
                  <div className="space-y-6 p-4">
                    {income.length > 0 && (
                      <section className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Income (money in)
                        </h4>
                        <EntriesSectionTable
                          entries={income}
                          showExtraColumns={showExtraColumns}
                          monthKey={monthKey}
                          resolveStatus={ownerLedgerRowStatus}
                          onRowClick={(entry) => setOverlay({ kind: "view", entry })}
                          onVoid={handleVoidEntry}
                        />
                      </section>
                    )}
                    {expenses.length > 0 && (
                      <section className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Expenses (paid by KAEN, deducted from payout)
                        </h4>
                        <Callout variant="info">
                          Utilities show the full supplier bill; the tenant&apos;s
                          share appears as income above, so your net cost is the
                          difference.
                        </Callout>
                        <EntriesSectionTable
                          entries={expenses}
                          showExtraColumns={showExtraColumns}
                          monthKey={monthKey}
                          resolveStatus={ownerLedgerRowStatus}
                          onRowClick={(entry) => setOverlay({ kind: "view", entry })}
                          onVoid={handleVoidEntry}
                        />
                      </section>
                    )}
                    {payouts.length > 0 && (
                      <section className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Payouts
                        </h4>
                        <EntriesSectionTable
                          entries={payouts}
                          showExtraColumns={showExtraColumns}
                          monthKey={monthKey}
                          resolveStatus={(entry) => ({
                            tone: getStatusTone(entry.paymentStatus),
                            label: labelFor(entry.paymentStatus),
                          })}
                          onRowClick={(entry) => setOverlay({ kind: "view", entry })}
                          onVoid={handleVoidEntry}
                        />
                      </section>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
        </>
      )}

      {/* ── Shared overlays ──────────────────────────────────────────────────── */}

      {/* Entry form drawer — create (kind=new) + read-only detail (kind=view) */}
      <EntryFormDrawer
        open={overlay?.kind === "new" || overlay?.kind === "view"}
        onClose={() => setOverlay(null)}
        mode={overlay?.kind === "view" ? "edit" : "create"}
        entry={overlay?.kind === "view" ? overlay.entry : undefined}
        readOnly={overlay?.kind === "view"}
        owners={owners}
        defaultOwnerPartyId={ownerPartyId}
      />

      {/* Record Payout drawer */}
      <RecordPayoutDrawer
        open={overlay?.kind === "payout"}
        onClose={() => setOverlay(null)}
        ownerPartyId={ownerPartyId}
        defaultPropertyId={firstPropertyId}
        carriedForward={Number(summary?.carriedForward ?? 0)}
      />

      {/* Month review sheet */}
      <MonthReviewSheet
        open={overlay?.kind === "month-review"}
        onClose={() => setOverlay(null)}
        initialOwnerPartyId={
          overlay?.kind === "month-review" ? overlay.ownerPartyId : ownerPartyId
        }
        initialMonth={
          overlay?.kind === "month-review" ? overlay.month : (toMonth || currentMonth())
        }
      />

      {/* Void confirm */}
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
                if (
                  err.message.includes("409") ||
                  err.message.toLowerCase().includes("conflict")
                ) {
                  toast.error(
                    "Entry was updated elsewhere. Please review the latest data.",
                  );
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
            ? overlay.entry.direction === "payout"
              ? `Void this ${formatRM(Number(overlay.entry.amount))} payout recorded on ${formatDate(overlay.entry.transactionDate)}? The carried-forward balance will increase by ${formatRM(Number(overlay.entry.amount))}. This cannot be undone.`
              : `${monthLabel(toMonthKey(overlay.entry.statementMonth))} · ${labelFor(overlay.entry.category)} · ${formatRM(Number(overlay.entry.amount))}. Voiding cannot be undone.`
            : ""
        }
        confirmLabel="Void entry"
        destructive
      />

      {/* Void & issue Credit Note — charge-derived ledger rows route here
          (mirrors unit-workspace.tsx). Reuses the P3.T11 VoidChargeDialog;
          no parallel void path. */}
      <VoidChargeDialog
        charge={voidChargeTarget}
        onClose={() => setOverlay(null)}
        onDone={() => {
          // Entries, summaries, payouts + figures all move — broad
          // invalidation is the safe cross-plan choice.
          void queryClient.invalidateQueries();
        }}
      />
    </div>
  );
}
