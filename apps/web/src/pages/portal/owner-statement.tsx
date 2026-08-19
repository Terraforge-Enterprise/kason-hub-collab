import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { portalApiFetch, PortalApiError } from "@/lib/portal-api";
import { isInformationalLedgerRow } from "@kason/shared";
import type { PortalOwnerDashboardResponse } from "@kason/shared";
import {
  useOwnerLedger,
  usePortalStatementSections,
  usePortalStatementProofs,
  downloadPortalProofPack,
  downloadPortalMonthRange,
} from "@/api/portal-owner-ledger";
import {
  MultiMonthDownload,
  type MultiMonthDownloadParams,
} from "@/pages/tenancy/owner-ledger/multi-month-download";
import { StatementDocumentsCard } from "./components/statement-documents-card";
import { StatementSectionHeader } from "@/pages/tenancy/owner-statement/statement-section-header";
import { StatementSectionOccupancy } from "@/pages/tenancy/owner-statement/statement-section-occupancy";
import { StatementSectionPayoutSummary } from "@/pages/tenancy/owner-statement/statement-section-payout-summary";
import { StatementSectionIncome } from "@/pages/tenancy/owner-statement/statement-section-income";
import { StatementSectionExpenses } from "@/pages/tenancy/owner-statement/statement-section-expenses";
import { ProofPackPanel } from "@/pages/tenancy/owner-statement/proof-pack-panel";
import { formatRM } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import { ReconciliationPanel } from "@/components/reconciliation-panel";
import {
  Banknote,
  Building2,
  CircleDollarSign,
  Download,
  FileText,
  History,
  Minus,
  Receipt,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { Segmented } from "@/components/ui/segmented";
import {
  usePortalOwnerTransactions,
  usePortalOwnerStatements,
  fetchPortalOwnerStatementPdfUrl,
  type OwnerTransactionRow,
} from "@/api/portal-owner-statements";

// ─── Statement list type (reused from owner-reports) ─────────────────────────
type StatementItem = {
  id: string;
  /** First-of-month ISO date string, or null when no period. */
  periodMonth: string | null;
  status: string;
  totalAmount: string;
  netRemittance?: string;
  /** Per-apartment scope — present when the statement was generated for a
   *  specific Apartment (Task 8+). Null for legacy owner-combined statements.
   *  Used by the unit selector to label statements per unitCode (Task 11). */
  apartmentId?: string | null;
};

type StatementsData = {
  month: string | null;
  statements: StatementItem[];
};

/** Statuses for which KAEN has generated a PDF the owner can download. */
const DOWNLOADABLE_STATUSES = new Set(["sent", "approved", "paid", "partial"]);

/** "YYYY-MM" from a first-of-month ISO date string, or "—" when absent. */
function periodLabel(periodMonth: string | null): string {
  if (!periodMonth) return "—";
  return periodMonth.slice(0, 7);
}

/** Statement status → Badge variant. */
function statementBadgeVariant(status: string): "emerald" | "amber" | "rose" {
  if (status === "paid" || status === "approved") return "emerald";
  if (status === "void" || status === "voided") return "rose";
  return "amber";
}

/**
 * Humanise a snake_case category key for display:
 *   "management_fee" → "Management Fee"
 *   "repair_maintenance" → "Repair Maintenance"
 */
function humaniseCategory(key: string): string {
  return key
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Owner-statement portal page. Flag-gated (merge-dark):
 *   - Flag OFF → the legacy single-month payout view, behaving EXACTLY as before.
 *   - Flag ON  → the two-view live-ledger surface (Transactions + Statements),
 *     the "bank transaction history vs bank statement" model (Task 10).
 */
export default function OwnerStatementPage() {
  const liveLedgerEnabled = isPhase2FlagEnabled(
    "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER",
  );
  if (liveLedgerEnabled) return <OwnerStatementLiveShell />;
  return <LegacyOwnerStatementView />;
}

function LegacyOwnerStatementView() {
  const now = new Date();
  const [month, setMonth] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  );
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined);

  /** Tracks which unit's statement is shown in multi-unit months.
   *  null → fall back to the first downloadable (or first of any) statement. */
  const [selectedStatementId, setSelectedStatementId] = useState<string | null>(null);

  // Dashboard data — used only to build the property id→name map for the filter.
  // The query key matches owner-dashboard.tsx so both pages share the same cache entry.
  const dashboardQuery = useQuery({
    queryKey: ["portal-owner-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalOwnerDashboardResponse }>("/dashboard"),
  });
  const propertyNameMap = Object.fromEntries(
    (dashboardQuery.data?.data?.properties ?? []).map((p) => [p.id, p.name]),
  );

  // Ledger: use the same month for both from and to (single-month view).
  const ledgerQuery = useOwnerLedger(month, month, propertyId);
  const data = ledgerQuery.data?.data;

  // KAEN-flow income rows.
  const incomeRows = data?.rows.filter((r) => r.direction === "income") ?? [];

  // KAEN-paid expense rows — paidBy === "kaen" is the runtime guard for
  // includeInPayout:true (the schema comment says "derived: paidBy == 'kaen'").
  // Owner-paid expense rows (paidBy !== "kaen") are intentionally excluded here.
  const kaenExpenseRows = data?.rows.filter(
    (r) => r.direction === "expense" && r.paidBy === "kaen",
  ) ?? [];

  // Σ income (all income rows on the ledger are gross rental for the owner).
  const rentCollected = incomeRows.reduce((sum, r) => sum + parseFloat(r.amount), 0);

  // Group KAEN-paid expenses by category for the "Less — paid by KAEN" section.
  const kaenByCategory = kaenExpenseRows.reduce<Record<string, number>>((acc, r) => {
    const cat = r.category;
    acc[cat] = (acc[cat] ?? 0) + parseFloat(r.amount);
    return acc;
  }, {});
  const kaenCategories = Object.entries(kaenByCategory);

  // Total KAEN-paid expenses (for a cross-check display).
  const totalKaenExpenses = kaenCategories.reduce((sum, [, v]) => sum + v, 0);

  // Net Payout — use the backend-computed summary field (authoritative).
  const netPayoutToOwner = data?.summary.netPayoutToOwner ?? null;

  // Balance fields from summary (T2 balance read).
  const broughtForward = data?.summary.broughtForward ?? null;
  const carriedForward = data?.summary.carriedForward ?? null;
  const carriedForwardNum = carriedForward !== null ? parseFloat(carriedForward) : null;
  const payoutsTotal = data?.summary.payoutsTotal ?? null;
  const payoutsTotalNum = payoutsTotal !== null ? parseFloat(payoutsTotal) : null;

  // M6 statements for the selected month (to check if a formal PDF exists).
  const statementsQuery = useQuery({
    queryKey: ["portal-statements", month],
    queryFn: () =>
      portalApiFetch<{ data: StatementsData }>(`/statements?month=${month}`),
  });

  // All statements for the selected month (one per apartment in the multi-unit case).
  const allStatements = statementsQuery.data?.data.statements ?? [];
  /** True when the owner has 2+ per-apartment statements for this month. */
  const multiUnit = allStatements.length > 1;

  // ── Multi-unit: user-controlled selection ────────────────────────────────
  // Default to the first downloadable statement so the PDF is immediately
  // accessible; fall back to the first of any status if none are downloadable.
  const defaultSelectedId =
    allStatements.find((s) => DOWNLOADABLE_STATUSES.has(s.status))?.id
    ?? allStatements[0]?.id
    ?? null;
  const effectiveStatementId = multiUnit
    ? (selectedStatementId ?? defaultSelectedId)
    : null;
  const effectiveStatement = multiUnit
    ? (allStatements.find((s) => s.id === effectiveStatementId) ?? null)
    : null;

  // ── Derived: which statement controls the PDF button + 5-section drill-in ──
  // Single-unit: preserve the original "first downloadable" logic unchanged.
  // Multi-unit:  the user-selected statement's status gates access.
  const downloadableStatement: StatementItem | null = multiUnit
    ? (effectiveStatement && DOWNLOADABLE_STATUSES.has(effectiveStatement.status)
        ? effectiveStatement
        : null)
    : (allStatements.find((s) => DOWNLOADABLE_STATUSES.has(s.status)) ?? null);

  // The "month has any statement" guard — used to show "Pending" vs EmptyState.
  const monthStatement: StatementItem | null = multiUnit
    ? effectiveStatement
    : (allStatements[0] ?? null);

  // ── aptToUnitCode: build apartment→unitCode map from ledger rows ─────────
  // Ledger rows already carry both apartmentId and unitCode (Task B1/B2),
  // so we don't need a separate endpoint to label the unit selector.
  const aptToUnitCode: Record<string, string> = {};
  for (const row of (data?.rows ?? [])) {
    if (row.apartmentId && row.unitCode) {
      aptToUnitCode[row.apartmentId] = row.unitCode;
    }
  }

  /** Select a unit statement and reset any per-statement PDF error. */
  function handleUnitSelect(id: string) {
    setSelectedStatementId(id);
    setPdfMissing(false);
  }

  const [downloading, setDownloading] = useState(false);
  const [pdfMissing, setPdfMissing] = useState(false);

  async function handleDownloadPdf() {
    if (!downloadableStatement) return;
    setDownloading(true);
    setPdfMissing(false);
    // Open the tab synchronously inside the click gesture. Calling window.open
    // AFTER the await trips popup blockers (they treat the deferred open as
    // non-user-initiated) — the "download shows nothing" bug. We navigate this
    // pre-opened tab once the signed URL resolves.
    const win = window.open("about:blank", "_blank");
    try {
      const res = await portalApiFetch<{ data: { downloadUrl: string } }>(
        `/statements/${downloadableStatement.id}/pdf`,
      );
      if (win) {
        win.opener = null;
        win.location.href = res.data.downloadUrl;
      } else {
        window.location.href = res.data.downloadUrl;
      }
    } catch (err) {
      win?.close();
      if (err instanceof PortalApiError && err.status === 404) {
        setPdfMissing(true);
        if (
          import.meta.env.DEV &&
          (downloadableStatement.status === "sent" ||
            downloadableStatement.status === "approved")
        ) {
          console.warn(
            `[owner-statement] statement ${downloadableStatement.id} (status=${downloadableStatement.status}) is missing its PDF.`,
          );
        }
      }
    } finally {
      setDownloading(false);
    }
  }

  const isLoading = ledgerQuery.isLoading;

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Banknote className="h-8 w-8 text-primary" />
            Statements
          </h1>
          <p className="text-muted-foreground mt-1">
            Monthly payout breakdown — what KAEN pays you
          </p>
        </div>
        <input
          type="month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setPdfMissing(false);
            // Reset the per-unit selection — a stale id from the previous month
            // would otherwise win over the new month's default and blank the
            // statement sections / mislabel the PDF card (multi-unit path).
            setSelectedStatementId(null);
          }}
          aria-label="Select month"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Optional property filter — only shown when there is more than one
          distinct property in the results (or while loading). Kept lightweight:
          a plain select populated from the returned rows rather than a
          separate /properties endpoint. */}
      <PropertyFilter
        rows={data?.rows ?? []}
        propertyId={propertyId}
        onSelect={setPropertyId}
        nameMap={propertyNameMap}
      />

      {isLoading && <StatementSkeleton />}

      {data && (
        <>
          {/* ── Stat row: Rent Collected + Net Payout ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <GlowCard
              glowColor="green"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">
                    Rent Collected
                  </p>
                  <p className="text-3xl font-bold text-emerald-500">
                    {formatRM(rentCollected)}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-green-600">
                    <CircleDollarSign className="h-3 w-3" />
                    <span>Gross rental this month</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-green-500/10">
                  <CircleDollarSign className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard
              glowColor="red"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">
                    KAEN-Paid Expenses
                  </p>
                  <p className="text-3xl font-bold text-rose-600">
                    {formatRM(totalKaenExpenses)}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Minus className="h-3 w-3" />
                    <span>Deducted from payout</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-red-500/10">
                  <Receipt className="h-6 w-6 text-red-600" />
                </div>
              </div>
            </GlowCard>

            <GlowCard
              glowColor="gold"
              className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 md:col-span-2 lg:col-span-1"
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">
                    Net Payout to You
                  </p>
                  <p
                    className={`text-3xl font-bold ${
                      netPayoutToOwner !== null && parseFloat(netPayoutToOwner) >= 0
                        ? "text-emerald-500"
                        : "text-rose-600"
                    }`}
                    data-testid="net-payout-value"
                  >
                    {netPayoutToOwner !== null
                      ? formatRM(parseFloat(netPayoutToOwner))
                      : "—"}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-green-600">
                    <TrendingUp className="h-3 w-3" />
                    <span>KAEN remits to you</span>
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-amber-500/10">
                  <Banknote className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </GlowCard>
          </div>

          {/* ── Payout breakdown card ── */}
          <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-bold flex items-center gap-2">
                <Receipt className="h-5 w-5 text-primary" />
                Payout Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Income line */}
              <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-widest">
                  Rent Collected
                </p>
                {incomeRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No income entries for this month.
                  </p>
                ) : (
                  incomeRows.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-foreground">
                        {r.description ?? humaniseCategory(r.category)}
                        {r.unitCode && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({r.unitCode})
                          </span>
                        )}
                      </span>
                      <span className="font-medium text-emerald-600 tabular-nums">
                        {formatRM(parseFloat(r.amount))}
                      </span>
                    </div>
                  ))
                )}
                <div className="flex items-center justify-between pt-2 border-t border-border/50 text-sm font-semibold">
                  <span className="text-foreground">Total</span>
                  <span className="text-emerald-600 tabular-nums">
                    {formatRM(rentCollected)}
                  </span>
                </div>
              </div>

              {/* Less — KAEN expenses */}
              {kaenCategories.length > 0 && (
                <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    Less — Paid by KAEN
                  </p>
                  {kaenCategories.map(([cat, amount]) => (
                    <div
                      key={cat}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-foreground">{humaniseCategory(cat)}</span>
                      <span className="font-medium text-rose-600 tabular-nums">
                        − {formatRM(amount)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-2 border-t border-border/50 text-sm font-semibold">
                    <span className="text-foreground">Total deductions</span>
                    <span className="text-rose-600 tabular-nums">
                      − {formatRM(totalKaenExpenses)}
                    </span>
                  </div>
                </div>
              )}

              {kaenCategories.length === 0 && (
                <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                  No KAEN-paid deductions for this month.
                </div>
              )}

              {/* Net Payout total row */}
              <div className="rounded-lg border border-border bg-background/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-base font-bold text-foreground">
                    Net Payout to You
                  </span>
                  <span
                    className={`text-2xl font-bold tabular-nums ${
                      netPayoutToOwner !== null &&
                      parseFloat(netPayoutToOwner) >= 0
                        ? "text-emerald-600"
                        : "text-rose-600"
                    }`}
                    data-testid="net-payout-breakdown-value"
                  >
                    {netPayoutToOwner !== null
                      ? formatRM(parseFloat(netPayoutToOwner))
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Running balance rows */}
              {(broughtForward !== null || carriedForward !== null) && (
                <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    Running Balance
                  </p>
                  {broughtForward !== null && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground">Brought forward</span>
                      <span className="font-medium tabular-nums text-foreground">
                        {formatRM(parseFloat(broughtForward))}
                      </span>
                    </div>
                  )}
                  {payoutsTotalNum !== null && payoutsTotalNum !== 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-foreground">Payouts this month</span>
                      <span className="font-medium tabular-nums text-rose-600">
                        -{formatRM(Math.abs(payoutsTotalNum))}
                      </span>
                    </div>
                  )}
                  {carriedForward !== null && (
                    <div className="flex items-center justify-between text-sm border-t border-border/50 pt-2">
                      <span className="font-semibold text-foreground">Carried forward</span>
                      <span
                        data-testid="carried-forward-portal-value"
                        className={`font-bold tabular-nums ${
                          carriedForwardNum !== null && carriedForwardNum < 0
                            ? "text-rose-600"
                            : "text-emerald-600"
                        }`}
                      >
                        {formatRM(carriedForwardNum ?? 0)}
                      </span>
                    </div>
                  )}
                  {carriedForwardNum !== null && carriedForwardNum < 0 && (
                    <p className="text-xs text-rose-500">
                      KAEN has fronted {formatRM(Math.abs(carriedForwardNum))} — rolls to next month.
                    </p>
                  )}
                </div>
              )}

              {/* Info callout — owner-paid items pointer */}
              <Callout variant="info">
                Owner-paid items appear in Income &amp; Tax — they don&apos;t reduce this
                payout.
              </Callout>
            </CardContent>
          </Card>

          {/* ── Unit selector (multi-apartment owners only) ── */}
          {multiUnit && !statementsQuery.isLoading && (
            <UnitStatementSelector
              statements={allStatements}
              effectiveId={effectiveStatementId}
              aptToUnitCode={aptToUnitCode}
              onSelect={handleUnitSelect}
            />
          )}

          {/* ── Formal statement PDF ── */}
          {!statementsQuery.isLoading && (
            <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl font-bold flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  Formal Statement
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {downloadableStatement ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div>
                          <span className="text-sm text-foreground block">
                            Statement — {periodLabel(downloadableStatement.periodMonth)}
                          </span>
                          <span className="text-xs text-muted-foreground block">
                            {downloadableStatement.netRemittance != null
                              ? `Net remittance: ${formatRM(parseFloat(downloadableStatement.netRemittance))}`
                              : ""}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={statementBadgeVariant(downloadableStatement.status)}>
                          {downloadableStatement.status}
                        </Badge>
                        <Button
                          variant="gold"
                          size="sm"
                          disabled={downloading || pdfMissing}
                          onClick={handleDownloadPdf}
                          data-testid="download-pdf-btn"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {downloading ? "Opening…" : "Download PDF"}
                        </Button>
                      </div>
                    </div>
                    {pdfMissing && (
                      <Callout variant="warning" title="PDF not ready">
                        The PDF for this statement isn&apos;t available yet. Contact your
                        property manager if you believe it should be ready.
                      </Callout>
                    )}
                  </>
                ) : (
                  <EmptyState
                    icon={FileText}
                    title="No formal statement for this month"
                    description="Your manager will generate and send the formal PDF statement once the month is finalized. It will appear here automatically."
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Detailed statement (5-section, read-only) — POSTED months only ── */}
          {/* Decision #3: the portal shows the full breakdown only after POST.
              A draft/un-posted month shows "Pending" with no drill-in. */}
          {!statementsQuery.isLoading && monthStatement && (
            downloadableStatement ? (
              <PortalStatementSections statementId={downloadableStatement.id} month={month} />
            ) : (
              <Callout variant="info" title="Pending">
                This month&apos;s statement is still being prepared. The full
                breakdown will appear here once your property manager posts it.
              </Callout>
            )
          )}
        </>
      )}

      {!isLoading && !data && (
        <EmptyState
          icon={Banknote}
          title="No data for this period"
          description="Ledger entries for the selected month will appear once your manager has posted them."
        />
      )}

      {/* Multi-month export (D2) — owner-scoped: download a date range of your own
          posted statements as one ZIP. No ownerPartyId field — it's always you. */}
      <PortalStatementExport />
    </div>
  );
}

// ─── Multi-month export (D2 — owner-scoped) ──────────────────────────────────

/**
 * Owner-portal wrapper around the shared MultiMonthDownload picker. Wires the
 * owner-scoped export route (downloadPortalMonthRange) — the owner is ALWAYS the
 * session, so the picker exposes NO ownerPartyId field. Owns the in-flight state +
 * error toast; renders the SAME picker as the admin workspace (visual parity).
 */
function PortalStatementExport() {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(params: MultiMonthDownloadParams) {
    setDownloading(true);
    try {
      await downloadPortalMonthRange(params);
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
      description="Download a date range of your posted statements as one ZIP."
    />
  );
}

// ─── Unit statement selector (multi-apartment, Task 11) ──────────────────────

/**
 * A pill-style unit selector shown when an owner has 2+ per-apartment statements
 * for the selected month. Selecting a pill switches which unit's formal statement
 * (PDF download + 5-section drill-in) is visible below it. The owner-level payout
 * summary stays unchanged above — it is always owner-combined.
 *
 * Labels are resolved via `aptToUnitCode` built from the ledger rows (both fields
 * already present in OwnerLedgerRowDto). Falls back to a shortened apartmentId
 * if the ledger doesn't contain a row for that apartment in the current period.
 */
function UnitStatementSelector({
  statements,
  effectiveId,
  aptToUnitCode,
  onSelect,
}: {
  statements: StatementItem[];
  effectiveId: string | null;
  aptToUnitCode: Record<string, string>;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" />
          Select Unit
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          You have statements for multiple units this month. Select a unit to view
          its formal PDF and detailed breakdown.
        </p>
        <div className="flex flex-wrap gap-2">
          {statements.map((stmt, index) => {
            // Prefer the real unitCode from the ledger; when the apartment has no
            // ledger row this month, fall back to a legible "Unit N" rather than a
            // raw UUID fragment.
            const code = stmt.apartmentId
              ? (aptToUnitCode[stmt.apartmentId] ?? `Unit ${index + 1}`)
              : "Statement";
            const isSelected = stmt.id === effectiveId;
            return (
              <button
                key={stmt.id}
                type="button"
                onClick={() => onSelect(stmt.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border/50 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/60 hover:text-foreground",
                )}
                aria-pressed={isSelected}
                aria-label={`Select unit ${code}`}
              >
                <span>{code}</span>
                <Badge variant={statementBadgeVariant(stmt.status)} className="text-xs">
                  {stmt.status}
                </Badge>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Property filter ──────────────────────────────────────────────────────────

/**
 * Renders a simple "All properties / specific property" select when the owner
 * has rows belonging to more than one distinct propertyId. Hidden when there
 * is zero or one property (no filtering needed).
 */
function PropertyFilter({
  rows,
  propertyId,
  onSelect,
  nameMap = {},
}: {
  rows: { propertyId: string }[];
  propertyId: string | undefined;
  onSelect: (id: string | undefined) => void;
  nameMap?: Record<string, string>;
}) {
  // Build unique propertyId list preserving order of first appearance.
  const ids = [...new Set(rows.map((r) => r.propertyId))];
  if (ids.length <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="property-filter"
        className="text-sm text-muted-foreground shrink-0"
      >
        Property:
      </label>
      <select
        id="property-filter"
        value={propertyId ?? ""}
        onChange={(e) => onSelect(e.target.value || undefined)}
        className="rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring"
      >
        <option value="">All properties</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {nameMap[id] ?? id}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function StatementSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-2xl" />
        ))}
      </div>
      <div className="h-64 bg-muted rounded-xl" />
      <div className="h-24 bg-muted rounded-xl" />
    </div>
  );
}

// ─── 5-section read-only drill-in (Task 2c-4) ──────────────────────────────────

/**
 * Renders the full 5-section Yannie statement (read-only) for a POSTED month,
 * reusing the SAME presentation components as the admin page (visual parity).
 * Owner-scoped data comes from GET /portal-api/owner/statements/:id/sections.
 */
function PortalStatementSections({ statementId, month }: { statementId: string; month: string }) {
  const sectionsQuery = usePortalStatementSections(statementId);
  const sections = sectionsQuery.data?.data;

  if (sectionsQuery.isLoading) return <SectionsSkeleton />;

  if (sectionsQuery.isError) {
    return (
      <Callout variant="danger" title="Couldn't load the detailed statement">
        Please refresh the page or try again shortly. If it keeps failing,
        contact your property manager.
      </Callout>
    );
  }

  if (!sections) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Detailed Statement</h2>
        <p className="text-sm text-muted-foreground">
          Read-only — exactly as posted by your property manager.
        </p>
      </div>
      <StatementSectionHeader data={sections.header} />
      <StatementSectionOccupancy data={sections.occupancy} />
      <StatementSectionPayoutSummary data={sections.payoutSummary} />
      <StatementSectionIncome data={sections.incomeBreakdown} />
      <StatementSectionExpenses data={sections.expenseBreakdown} />
      {/* Bills & Proof (C2) — READ-ONLY: the owner can view + download the supporting
          bills behind this POSTED statement, but never attach/detach. The portal
          endpoints are owner-scoped + POST-only-gated on the server. */}
      <PortalBillsProofPanel statementId={statementId} statementMonth={month} />
      {/* Accounting docs (§4.2): IVOWN invoice + CNs behind this statement. */}
      <StatementDocumentsCard statementId={statementId} />
    </div>
  );
}

/**
 * Owner-portal Bills & Proof panel (C2, read-only). Fetches the supporting bills for
 * the owner's own POSTED statement via the owner-scoped, POST-only endpoint and
 * renders the SHARED ProofPackPanel with NO attach/detach affordance. "Download all
 * bills" streams the merged proof-pack PDF through the owner-scoped route.
 */
function PortalBillsProofPanel({
  statementId,
  statementMonth,
}: {
  statementId: string;
  statementMonth: string;
}) {
  const proofsQuery = usePortalStatementProofs(statementId);
  const [downloading, setDownloading] = useState(false);

  async function handleDownloadAll() {
    setDownloading(true);
    try {
      await downloadPortalProofPack(statementId, statementMonth);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not download the bills.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <ProofPackPanel
      groups={proofsQuery.data?.data ?? []}
      isLoading={proofsQuery.isLoading}
      downloading={downloading}
      onDownloadAll={handleDownloadAll}
    />
  );
}

function SectionsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-56 bg-muted rounded" />
      <div className="h-40 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
      <div className="h-56 bg-muted rounded-xl" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task 10 — Live-ledger surface (flag ON): Transactions (live) vs Statements (frozen)
// ═══════════════════════════════════════════════════════════════════════════════

/** "2026-05" → "May 2026" (UTC-safe — the month key is a UTC first-of-month). */
function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-MY", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Integer cents (frozen-statement *C fields) → RM display. */
function formatCents(c: number): string {
  return formatRM(c / 100);
}

/** ISO timestamp → "05 Jul 2026" (UTC-safe). */
function formatTxDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type LiveView = "transactions" | "statements";

/**
 * Two-view owner surface. A Segmented control switches between the LIVE
 * transaction history (current month included — the "transaction history") and
 * the FROZEN formal statements (current month excluded — the "bank statement").
 * Read-only: the owner sees only their own data (session-scoped on the backend);
 * no owner/org id is ever passed and there are no editing affordances.
 */
function OwnerStatementLiveShell() {
  const [view, setView] = useState<LiveView>("transactions");

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Banknote className="h-8 w-8 text-primary" />
            Statements
          </h1>
          <p className="text-muted-foreground mt-1">
            Your live transaction history and formal monthly statements
          </p>
        </div>
      </div>

      <Segmented<LiveView>
        value={view}
        onChange={setView}
        ariaLabel="Statement view"
        className="max-w-md"
        options={[
          { value: "transactions", label: "Transactions", icon: History },
          { value: "statements", label: "Statements", icon: FileText },
        ]}
      />

      {view === "transactions" ? <OwnerTransactionsView /> : <OwnerStatementsView />}
    </div>
  );
}

/** One line in the balance-summary breakdown card. */
function BalanceSummaryRow({
  label,
  value,
  negative = false,
}: {
  label: string;
  value: string;
  negative?: boolean;
}) {
  const n = parseFloat(value);
  const display = Number.isNaN(n) ? value : formatRM(Math.abs(n));
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-medium tabular-nums",
          negative ? "text-rose-600" : "text-foreground",
        )}
      >
        {negative ? "− " : ""}
        {display}
      </span>
    </div>
  );
}

/**
 * A single settled cash transaction — income is a credit (+), expense/payout a debit (−).
 * An INFORMATIONAL row (e.g. the first-month letting commission) is neither: it moved no
 * money for the owner, so it renders unsigned and muted. Without this branch the
 * `isCredit ? "+" : "−"` fallback below would stamp it as a red debit and read like a
 * deduction the owner never actually bore.
 */
function TransactionRow({ row }: { row: OwnerTransactionRow }) {
  const informational = isInformationalLedgerRow(row);
  const isCredit = row.direction === "income";
  const amount = parseFloat(row.amount);
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground truncate">
          {row.description ?? humaniseCategory(row.category)}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatTxDate(row.transactionDate)} · {humaniseCategory(row.category)}
        </p>
      </div>
      <span
        className={cn(
          "font-medium tabular-nums shrink-0",
          informational ? "text-muted-foreground" : isCredit ? "text-emerald-600" : "text-rose-600",
        )}
      >
        {informational ? "" : isCredit ? "+ " : "− "}
        {formatRM(Math.abs(Number.isNaN(amount) ? 0 : amount))}
      </span>
    </div>
  );
}

/**
 * Transactions view — the LIVE running history. Renders the authoritative
 * `balance` summary (opening/net/closing from resolveOwnerBalance) as header
 * cards and the settled cash `rows` as a transaction list. The current open
 * month is INCLUDED. We deliberately do NOT compute a per-row running balance:
 * `balance` is accrual/deposit-aware and would not reconcile to a cash tally of
 * these settled rows.
 */
function OwnerTransactionsView() {
  const txQuery = usePortalOwnerTransactions();
  const data = txQuery.data?.data;

  if (txQuery.isLoading) return <StatementSkeleton />;
  if (txQuery.isError || !data) {
    return (
      <Callout variant="danger" title="Couldn't load your transactions">
        Please refresh the page or try again shortly. If it keeps failing, contact
        your property manager.
      </Callout>
    );
  }

  const { balance, rows } = data;
  const carried = parseFloat(balance.carriedForward);
  const carriedNeg = !Number.isNaN(carried) && carried < 0;

  return (
    <div className="space-y-6">
      {/* Authoritative balance SUMMARY (not a per-row running total). */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <p className="text-sm font-medium text-muted-foreground">Brought Forward</p>
          <p className="text-2xl font-bold text-foreground tabular-nums mt-2">
            {formatRM(parseFloat(balance.broughtForward))}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Opening balance for this window</p>
        </GlowCard>

        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <p className="text-sm font-medium text-muted-foreground">Net This Period</p>
          <p
            className="text-2xl font-bold text-amber-500 tabular-nums mt-2"
            data-testid="live-net-this-period"
          >
            {formatRM(parseFloat(balance.netThisPeriod))}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Income + deposits − expenses</p>
        </GlowCard>

        <GlowCard
          glowColor={carriedNeg ? "red" : "green"}
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <p className="text-sm font-medium text-muted-foreground">Carried Forward</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums mt-2",
              carriedNeg ? "text-rose-600" : "text-emerald-500",
            )}
            data-testid="live-carried-forward"
          >
            {formatRM(Number.isNaN(carried) ? 0 : carried)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {carriedNeg ? "KAEN has fronted this — rolls forward" : "Closing balance to date"}
          </p>
        </GlowCard>
      </div>

      {/* Balance breakdown */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Balance Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
            <BalanceSummaryRow label="Gross rental" value={balance.periodGross} />
            <BalanceSummaryRow label="Expenses" value={balance.periodExpenses} negative />
            <BalanceSummaryRow label="Deposits collected" value={balance.depositCollected} />
            <BalanceSummaryRow label="Payouts to you" value={balance.periodPayouts} negative />
          </div>
          <Callout variant="info">
            This is your live running balance — the current month is included. Formal
            monthly statements appear under the Statements tab.
          </Callout>
        </CardContent>
      </Card>

      {/* Transaction list */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Transaction History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="No transactions yet"
              description="Your settled income and expenses will appear here as your manager posts them."
            />
          ) : (
            <div className="divide-y divide-border/50">
              {rows.map((r) => (
                <TransactionRow key={r.id} row={r} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Statements view — the FROZEN formal documents only. The current open month is
 * NEVER here (the backend excludes it; it lives under Transactions). Each frozen
 * statement offers a signed-URL PDF download. Read-only.
 */
function OwnerStatementsView() {
  const stmtQuery = usePortalOwnerStatements();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const reconciliationPanel = isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER") ? (
    <ReconciliationPanel />
  ) : null;

  async function handleDownload(id: string) {
    setDownloadingId(id);
    setErrorId(null);
    // Popup-blocker-safe: open a blank tab synchronously inside the click gesture,
    // then navigate it once the signed URL resolves (mirrors the legacy handler).
    const win = window.open("about:blank", "_blank");
    try {
      const url = await fetchPortalOwnerStatementPdfUrl(id);
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        // Popup blocked → navigate the current tab. Method call (not a `.href =`
        // property assignment on the global) so react-hooks/immutability is happy.
        window.location.assign(url);
      }
    } catch {
      win?.close();
      setErrorId(id);
    } finally {
      setDownloadingId(null);
    }
  }

  if (stmtQuery.isLoading)
    return (
      <>
        {reconciliationPanel}
        <StatementSkeleton />
      </>
    );
  if (stmtQuery.isError || !stmtQuery.data) {
    return (
      <>
        {reconciliationPanel}
        <Callout variant="danger" title="Couldn't load your statements">
          Please refresh the page or try again shortly. If it keeps failing, contact
          your property manager.
        </Callout>
      </>
    );
  }

  const items = stmtQuery.data.data.items;
  if (items.length === 0) {
    return (
      <>
        {reconciliationPanel}
        <EmptyState
          icon={FileText}
          title="No statements yet"
          description="Your formal monthly statements will appear here once a month closes and is finalized. The current month stays under Transactions until then."
        />
      </>
    );
  }

  return (
    <>
      {reconciliationPanel}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Formal Statements
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {items.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <span className="text-sm text-foreground block">
                    Statement — {formatMonthLabel(s.month)}
                  </span>
                  <span className="text-xs text-muted-foreground block">
                    Net payout: {formatCents(s.netPayoutC)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="emerald">Issued</Badge>
                {s.pdfKey ? (
                  <Button
                    variant="gold"
                    size="sm"
                    disabled={downloadingId === s.id}
                    onClick={() => handleDownload(s.id)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {downloadingId === s.id ? "Opening…" : "Download PDF"}
                  </Button>
                ) : (
                  <Badge variant="amber">PDF pending</Badge>
                )}
              </div>
              {errorId === s.id && (
                <div className="w-full">
                  <Callout variant="warning" title="PDF not ready">
                    The PDF for this statement isn&apos;t available yet. Contact your
                    property manager if you believe it should be ready.
                  </Callout>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
