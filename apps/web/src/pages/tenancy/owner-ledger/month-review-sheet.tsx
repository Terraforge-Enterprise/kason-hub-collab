// Admin Owner-Ledger month-review + sync sheet (M6b / T4).
//
// Opened from the "Month review" button on owner-ledger-page.tsx.
// Shows summary GlowCards for the selected owner+month, a byCategory breakdown,
// the month's entries table, a "Sync this month" button (useSyncMonth), and a
// "Download statement PDF" action.
//
// The "Issue management fee" action was REMOVED (2026-08-01). The fee is minted
// automatically the moment a tenant's rent Charge reaches `paid`:
// afterPaymentSettled → issueMgmtFeeForPaidRent calls the very same
// generateStatementService this button called. So the click was a no-op in the
// normal case (generateStatementService returns the existing draft), and on a
// month whose rent was NOT fully settled it billed the fee off CONTRACTED rent
// while the owner ledger deducts off COLLECTED — reintroducing the exact
// two-numbers-one-fee mismatch the payment hook was written to eliminate. See
// mgmt-fee-on-payment.hook.ts's module docstring.
//
// Sheet size="xl" — mirrors statement-detail-sheet.tsx structure.
import { useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, FileText, BarChart3, Download } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { GlowCard } from "@/components/ui/glow-card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SelectInput } from "@/components/form-ui";
import { StatusPill } from "@/components/ui";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { apiFetch } from "@/lib/api-client";
import { labelFor } from "@/lib/string-utils";
import {
  useSyncMonth,
  useOwnerLedgerSummary,
  useOwnerLedgerEntries,
  type OwnerLedgerEntryRow,
} from "@/api/owner-ledger";
import { downloadLiveStatementPdf } from "@/api/owner-billing";
import { ownerLedgerRowStatus, groupByDirection } from "./ledger-presentation";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type OwnerOption = { id: string; displayName: string };

export type MonthReviewSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-seed owner from the page filter — user can change it inside the sheet. */
  initialOwnerPartyId?: string;
  /** Pre-seed month (YYYY-MM) from the page filter. */
  initialMonth?: string;
};

// ─── Fetch-gate helpers ────────────────────────────────────────────────────────
// Queries are disabled when the sheet is closed to avoid spurious network calls.

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Today as YYYY-MM default for the month picker. */
function todayMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function MonthReviewSheet({
  open,
  onClose,
  initialOwnerPartyId = "",
  initialMonth = "",
}: MonthReviewSheetProps) {
  // Owner + month selectors — pre-seeded from page filters, editable inside.
  const [ownerPartyId, setOwnerPartyId] = useState(initialOwnerPartyId);
  const [month, setMonth] = useState(initialMonth || todayMonth());

  // Live PDF download. No confirm — it writes nothing, server-side or otherwise;
  // it just renders the current figures. Own pending flag because it is a plain
  // fetch + blob download, not a react-query mutation.
  const [pdfPending, setPdfPending] = useState(false);

  // Owner options — same source as owner-ledger-page
  const ownersQuery = useQuery({
    queryKey: ["owners"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>("/parties/owners"),
  });
  const owners: OwnerOption[] = ownersQuery.data?.data ?? [];
  const selectedOwnerName = owners.find((o) => o.id === ownerPartyId)?.displayName ?? ownerPartyId;

  // Gate all data fetches: don't fire when the sheet is closed.
  const fetchEnabled = open && !!ownerPartyId && !!month;

  // Summary: fromMonth=toMonth=selected month
  const summaryQuery = useOwnerLedgerSummary({
    ownerPartyId: ownerPartyId || undefined,
    fromMonth: fetchEnabled ? month : "",
    toMonth: fetchEnabled ? month : "",
  });
  const summary = summaryQuery.data?.data;

  // Entries for the month (gated via enabled option)
  const entriesQuery = useOwnerLedgerEntries(
    {
      ownerPartyId: ownerPartyId || undefined,
      month: month || undefined,
      limit: 100,
    },
    { enabled: fetchEnabled },
  );
  const entries: OwnerLedgerEntryRow[] = entriesQuery.data?.data.rows ?? [];

  // Sync mutation
  const syncMonth = useSyncMonth();

  async function handleDownloadPdf() {
    setPdfPending(true);
    try {
      await downloadLiveStatementPdf({ ownerPartyId, billingMonth: month });
      toast.success(`Statement PDF generated for ${selectedOwnerName} (${month}).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate the PDF.");
    } finally {
      setPdfPending(false);
    }
  }

  function handleSync() {
    if (!ownerPartyId) {
      toast.error("Select an owner before syncing.");
      return;
    }
    if (!month) {
      toast.error("Select a month before syncing.");
      return;
    }
    syncMonth.mutate(
      { ownerPartyId, month },
      {
        onSuccess: (res) => {
          const { created, updated, skipped } = res.data;
          toast.success(`Synced: ${created} created, ${updated} updated, ${skipped} skipped`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  const isReady = !!(ownerPartyId && month);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            Month review
          </SheetTitle>
          <SheetDescription>
            {isReady
              ? `${selectedOwnerName} — ${month}`
              : "Select an owner and month to review the ledger."}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          <div className="space-y-6">
            {/* ── Controls ─────────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Owner
                </label>
                <SelectInput
                  aria-label="Owner"
                  value={ownerPartyId}
                  onChange={(e) => setOwnerPartyId(e.target.value)}
                  className="min-h-0 w-60 py-1.5"
                  disabled={ownersQuery.isLoading}
                >
                  <option value="">{ownersQuery.isLoading ? "Loading…" : "Select an owner…"}</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.displayName}
                    </option>
                  ))}
                </SelectInput>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Month
                </label>
                <input
                  type="month"
                  aria-label="Month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="min-h-0 w-44 rounded-md border border-border/50 bg-background/60 px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <Button
                type="button"
                variant="outline"
                disabled={!isReady || syncMonth.isPending}
                onClick={handleSync}
                data-testid="sync-button"
              >
                <RefreshCw className="h-4 w-4" />
                {syncMonth.isPending ? "Syncing…" : "Sync this month"}
              </Button>
            </div>

            {/* ── Summary cards ─────────────────────────────────────────────── */}
            {isReady && (
              <>
                {summaryQuery.isLoading ? (
                  <div className="grid grid-cols-2 gap-4 animate-pulse sm:grid-cols-4">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="h-24 rounded-2xl bg-muted" />
                    ))}
                  </div>
                ) : summaryQuery.isError ? (
                  <Callout variant="danger" title="Couldn't load summary">
                    Failed to load the month summary. Try again.
                  </Callout>
                ) : summary ? (
                  <>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <GlowCard glowColor="green" className="p-4">
                        <p className="text-xs text-muted-foreground">Gross Rental</p>
                        <p
                          className="mt-1 text-lg font-bold text-foreground tabular-nums"
                          data-testid="gross-rental"
                        >
                          {formatRM(Number(summary.grossRental))}
                        </p>
                      </GlowCard>
                      <GlowCard glowColor="orange" className="p-4">
                        <p className="text-xs text-muted-foreground">Total Expenses</p>
                        <p
                          className="mt-1 text-lg font-bold text-foreground tabular-nums"
                          data-testid="total-expenses"
                        >
                          {formatRM(Number(summary.totalExpenses))}
                        </p>
                      </GlowCard>
                      <GlowCard glowColor="blue" className="p-4">
                        <p className="text-xs text-muted-foreground">Net Rental After Expenses</p>
                        <p
                          className="mt-1 text-lg font-bold text-foreground tabular-nums"
                          data-testid="net-rental"
                        >
                          {formatRM(Number(summary.netRentalAfterExpenses))}
                        </p>
                      </GlowCard>
                      <GlowCard glowColor="gold" className="p-4">
                        <p className="text-xs text-muted-foreground">Net Payout to Owner</p>
                        <p
                          className="mt-1 text-lg font-bold text-foreground tabular-nums"
                          data-testid="net-payout"
                        >
                          {formatRM(Number(summary.netPayoutToOwner))}
                        </p>
                      </GlowCard>
                    </div>

                    <Callout variant="info">
                      <span className="text-xs text-muted-foreground">
                        <strong>Net Rental After Expenses</strong> deducts all expenses from gross
                        rental. <strong>Net Payout to Owner</strong> is lower because owner-paid
                        expenses (paidBy = owner) are excluded — only Kaen-paid expenses reduce the
                        payout.
                      </span>
                    </Callout>

                    {/* byCategory breakdown */}
                    {Object.keys(summary.byCategory).length > 0 && (
                      <section className="space-y-2">
                        <h3 className="text-sm font-semibold text-foreground">
                          Breakdown by category
                        </h3>
                        <div className="rounded-lg border border-border/50 bg-background/40 divide-y divide-border/40">
                          {Object.entries(summary.byCategory).map(([cat, amount]) => (
                            <div key={cat} className="flex items-center justify-between px-4 py-2 text-sm">
                              <span className="text-muted-foreground">{labelFor(cat)}</span>
                              <span className="font-medium tabular-nums">
                                {formatRM(Number(amount))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </>
                ) : null}

                {/* ── Entries table ──────────────────────────────────────── */}
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" /> Ledger entries — {month}
                  </h3>
                  <EntriesTable entries={entries} isLoading={entriesQuery.isLoading} />
                </section>
              </>
            )}

            {!isReady && (
              <Callout variant="info">
                Select an owner and month above to load the summary and entries.
              </Callout>
            )}
          </div>
        </SheetBody>

        <SheetFooter>
          <Button
            type="button"
            variant="gold"
            disabled={!isReady || pdfPending}
            onClick={handleDownloadPdf}
            data-testid="download-statement-pdf-button"
          >
            <Download className="h-4 w-4" />
            {pdfPending ? "Generating…" : "Download statement PDF"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─── Entries table ─────────────────────────────────────────────────────────────

function EntriesTable({
  entries,
  isLoading,
}: {
  entries: OwnerLedgerEntryRow[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <div className="h-32 rounded-lg bg-muted animate-pulse" />;
  }

  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border/50 bg-background/40 px-4 py-6 text-center text-sm text-muted-foreground">
        No entries for this owner + month.
      </p>
    );
  }

  // Income/Expenses/Payouts split (owner-ledger view clarity, Task 4). Payouts
  // are carved out separately — NOT dropped — mirroring owner-workspace.tsx's
  // EntriesSectionTable docstring: a payout must never be resolved via
  // ownerLedgerRowStatus, since its non-income branch reads includeInPayout
  // (false for a payout row, same as an owner-paid expense) and would
  // mislabel it "Owner-paid"; use getStatusTone(paymentStatus)/labelFor below.
  const { income, expenses } = groupByDirection(entries);
  const payouts = entries.filter((e) => e.direction === "payout");

  return (
    <div className="space-y-4">
      {income.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Income (money in)
          </h4>
          <EntriesSection entries={income} />
        </div>
      )}
      {expenses.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Expenses (paid by KAEN, deducted from payout)
          </h4>
          <Callout variant="info">
            Utilities show the full supplier bill; the tenant&apos;s share appears
            as income above, so your net cost is the difference.
          </Callout>
          <EntriesSection entries={expenses} />
        </div>
      )}
      {payouts.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Payouts
          </h4>
          <EntriesSection
            entries={payouts}
            resolveStatus={(entry) => ({
              tone: getStatusTone(entry.paymentStatus),
              label: labelFor(entry.paymentStatus),
            })}
          />
        </div>
      )}
    </div>
  );
}

/** One direction's table — Income, Expenses, or Payouts (EntriesTable above).
 * All three share the SAME aria-label: existing fixtures never populate more
 * than one group at once, so `getByRole("table", {name: /Ledger entries/i})`
 * stays unambiguous; a future test asserting on multiple tables simultaneously
 * should scope via `within()` per section instead.
 *
 * `resolveStatus` defaults to `ownerLedgerRowStatus` (Income/Expenses'
 * existing behavior, unchanged) but Payouts overrides it with
 * getStatusTone(paymentStatus)/labelFor — see the caller in EntriesTable for
 * why ownerLedgerRowStatus would mislabel a payout row. */
function EntriesSection({
  entries,
  resolveStatus = ownerLedgerRowStatus,
}: {
  entries: OwnerLedgerEntryRow[];
  resolveStatus?: (entry: OwnerLedgerEntryRow) => ReturnType<typeof ownerLedgerRowStatus>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table
        className="min-w-full border-collapse text-left text-sm"
        aria-label="Ledger entries"
      >
        <thead className="border-b border-border/50 bg-background/40 text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-semibold">Date</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold text-right">Amount</th>
            <th className="px-3 py-2 font-semibold">Paid By</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const st = resolveStatus(entry);
            return (
              <tr
                key={entry.id}
                className={`border-b border-border/40 ${entry.status === "void" ? "opacity-50" : ""}`}
              >
                <td className="px-3 py-2.5 tabular-nums text-sm">
                  {formatDate(entry.transactionDate)}
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {labelFor(entry.category)}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill tone={st.tone}>{st.label}</StatusPill>
                </td>
                <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                  {formatRM(Number(entry.amount))}
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill tone={entry.paidBy === "kaen" ? "sky" : "slate"}>
                    {labelFor(entry.paidBy)}
                  </StatusPill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
