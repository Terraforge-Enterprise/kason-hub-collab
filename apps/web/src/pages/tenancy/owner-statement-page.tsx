// Admin Owner Statement Page (Task 2c-3)
//
// Route: /tenancy/owners/:ownerPartyId/statements/:month
// Flag-gated: VITE_ENABLE_PHASE2_OWNER_BILLING (route registration in router.tsx)
//
// Renders the full 5-section Yannie statement for a single owner+month.
// Derives statementId from useOwnerMonthlySummaries: find row.month === month.
// Sections render from the LIVE ledger when nothing has been issued yet, and from
// the issued statement once one exists — both paths feed identical YannieSections.
//
// NO MANUAL ISSUE / APPROVE / SEND (2026-08-01). The management fee is minted
// automatically by the payment hook: `afterPaymentSettled` →
// `issueMgmtFeeForPaidRent` calls generateStatementService the moment a rent Charge
// reaches `paid`, so by the time an admin opens this page the statement Invoice and
// its mgmt-fee Charges already exist and a manual "Issue" was a no-op (the
// idempotency return in generateStatementService). Worse, on a month whose rent was
// NOT fully paid the manual path computed the fee off CONTRACTED rent while the
// owner ledger deducts off COLLECTED — the exact mismatch the hook was built to
// remove (see mgmt-fee-on-payment.hook.ts's module docstring). The button's only
// remaining power was to re-create that bug, so it is gone.
//
// Safe to remove unconditionally: this route is registered behind
// ENABLE_PHASE2_OWNER_BILLING (router.tsx) and the auto-issue hook is gated on the
// SAME flag — wherever the page is reachable, the automation is already running.
//
// The month-end statement is created, frozen, approved and sent by cron; see
// apps/api/src/cron/freeze-owner-statements.ts + send-owner-statements.ts.
//
// Actions (real endpoints only — no dead buttons):
//   • Print PDF (GET /owner-billing/statements/live-pdf) — ALWAYS available, renders
//     the figures as they stand right now. Stored nowhere; needs no issued statement.
//   • View issued PDF (GET /statements/:id/pdf) — only when a formal copy exists.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft,
  Download,
  FileText,
  Printer,
  TrendingUp,
  DollarSign,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { EmptyState } from "@/components/empty-state";
import { formatRM } from "@/components/format";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import {
  useOwnerMonthlySummaries,
  useStatementSections,
  useLiveStatementSections,
  type MonthlyStatementSummary,
  type YannieSections,
} from "@/api/owner-ledger";
import {
  fetchStatementPdfUrl,
  useStatement,
  useExpenseProofs,
  useAttachExpenseProof,
  useDetachExpenseProof,
  downloadProofPack,
  downloadLiveStatementPdf,
} from "@/api/owner-billing";
import { StatementSectionHeader } from "./owner-statement/statement-section-header";
import { StatementSectionOccupancy } from "./owner-statement/statement-section-occupancy";
import { StatementSectionPayoutSummary } from "./owner-statement/statement-section-payout-summary";
import { StatementSectionIncome } from "./owner-statement/statement-section-income";
import { StatementSectionExpenses } from "./owner-statement/statement-section-expenses";
import { ProofPackPanel } from "./owner-statement/proof-pack-panel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "2026-06" → "June 2026" */
function humanMonth(yyyyMm: string): string {
  if (!yyyyMm || !yyyyMm.includes("-")) return yyyyMm;
  const [year, month] = yyyyMm.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleString("en-MY", { month: "long", year: "numeric" });
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-80 bg-muted rounded" />
      <div className="h-8 w-52 bg-muted rounded" />
      <div className="h-40 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
      <div className="h-56 bg-muted rounded-xl" />
      <div className="h-56 bg-muted rounded-xl" />
    </div>
  );
}


// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OwnerStatementPage() {
  const { ownerPartyId = "", month = "", apartmentId } = useParams<{
    ownerPartyId: string;
    month: string;
    /** Present on the per-unit route (/units/:apartmentId/statements/:month); absent on the legacy route. */
    apartmentId?: string;
  }>();

  const [viewingPdf, setViewingPdf] = useState(false);
  const [printingPdf, setPrintingPdf] = useState(false);

  // ── Step 1: resolve statementId from monthly summaries ───────────────────────
  // Pass apartmentId so the query is scoped to the per-unit ledger when present.
  // When absent (legacy route) behavior is exactly as before.
  const summariesQuery = useOwnerMonthlySummaries(ownerPartyId || undefined, apartmentId);
  const summaryRow = summariesQuery.data?.data.items.find((r) => r.month === month);
  const statementId = summaryRow?.statementId ?? null;

  // ── Task 9: live-ledger flag (web mirror of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER) ─
  // Flag ON  → the admin sees the live figures (summaryRow already carries them,
  //            computed from the posted ledger), and Print PDF renders those same
  //            figures on demand via GET /statements/live-pdf.
  // Flag OFF → the live sections and the live-pdf endpoint both 404, so the page
  //            shows only what has been issued. Nothing is manually issuable either
  //            way — the payment hook owns that.
  const liveLedgerEnabled = isPhase2FlagEnabled(
    "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER",
  );

  // ── Step 2: fetch 5-section data (only when statementId known) ───────────────
  const sectionsQuery = useStatementSections(statementId ?? undefined);
  const sections = sectionsQuery.data?.data;

  // ── Step 2b: LIVE 5-section data (flag on + no statement issued) ─────────────
  // Close the gap: viewing the full 5-section DETAIL no longer requires issuing.
  // When the live-ledger flag is on and no statement exists yet, fetch the SAME
  // sections computed straight from the posted ledger. Gating both args on
  // (liveLedgerEnabled && !statementId) keeps this query DISABLED — no network,
  // flag-off byte-identical — everywhere except the live view.
  const liveEligible = liveLedgerEnabled && !statementId;
  const liveSectionsQuery = useLiveStatementSections(
    liveEligible ? ownerPartyId || undefined : undefined,
    liveEligible ? month || undefined : undefined,
    apartmentId,
  );
  const liveSections = liveSectionsQuery.data?.data;

  // ── Step 3: fetch statement detail for action gating (status + pdfKey) ───────
  const statementQuery = useStatement(statementId);
  const statement = statementQuery.data?.data;

  // ── Action: Print PDF (live — no issued statement required) ──────────────────
  // Renders the 5 sections straight from the posted ledger and streams the bytes
  // back; the server stores nothing, so every click reflects the figures as they
  // stand (an unpaid tenant reads as unpaid). This is admin's working copy — the
  // owner's copy is rendered from the frozen month-end snapshot by the send cron.
  // Deliberately has no gate: no issue, no approval, no pdfKey.
  async function handlePrintPdf() {
    if (!ownerPartyId || !month) return;
    setPrintingPdf(true);
    try {
      await downloadLiveStatementPdf({
        ownerPartyId,
        billingMonth: month,
        // Scope to the apartment when on the per-unit route; omit for combined.
        ...(apartmentId ? { apartmentId } : {}),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate the PDF.");
    } finally {
      setPrintingPdf(false);
    }
  }

  // ── Action: View issued PDF (immediate — no confirm dialog) ──────────────────
  async function handleViewPdf() {
    if (!statementId) return;
    setViewingPdf(true);
    try {
      const url = await fetchStatementPdfUrl(statementId);
      if (!url) {
        if (import.meta.env.DEV)
          console.warn("[owner-statement] pdfKey present but signed URL fetch returned empty");
        toast.error("Could not retrieve the PDF link. Try regenerating the PDF.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open the PDF.");
    } finally {
      setViewingPdf(false);
    }
  }

  // ── Derived action availability ───────────────────────────────────────────────
  // Print is unconditional when the live endpoint exists; viewing the FORMAL copy
  // still requires one to have been rendered (by the month-end cron).
  const canPrintPdf = liveLedgerEnabled;
  const canViewPdf = statement?.pdfKey != null;

  // ── Loading ───────────────────────────────────────────────────────────────────
  const isLoadingBase = summariesQuery.isLoading;
  const isLoadingSections = sectionsQuery.isLoading && !!statementId;

  if (isLoadingBase || isLoadingSections) {
    return (
      <div className="space-y-4">
        <BackCrumb ownerPartyId={ownerPartyId} />
        <PageSkeleton />
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  if (sectionsQuery.isError) {
    return (
      <div className="space-y-6">
        <BackCrumb ownerPartyId={ownerPartyId} />
        <PageHeader
          title={humanMonth(month)}
          icon={FileText}
          description="Owner statement"
        />
        <Callout variant="danger" title="Failed to load statement">
          Could not load statement sections. Please refresh or go back.
        </Callout>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  const ownerName = sections?.header.ownerName ?? "";
  if (import.meta.env.DEV && sections && !sections.header.ownerName)
    console.warn("[owner-statement] missing ownerName in header");

  return (
    <div className="space-y-6">
      {/* Back crumb */}
      <BackCrumb ownerPartyId={ownerPartyId} />

      {/* Page header */}
      <PageHeader
        title={`${humanMonth(month)} Statement`}
        icon={FileText}
        description={ownerName ? `Owner: ${ownerName}` : `Owner statement for ${month}`}
        actions={
          <ActionButtons
            canPrintPdf={canPrintPdf}
            canViewPdf={canViewPdf}
            isPrintingPdf={printingPdf}
            isViewingPdf={viewingPdf}
            onPrintPdf={handlePrintPdf}
            onViewPdf={handleViewPdf}
          />
        }
      />

      {/* No statement state — FLAG OFF. Without the live-ledger flag there are no
          live sections and no live PDF, so the page can only report that nothing
          has been issued yet. Nothing to click: the statement is minted by the
          payment hook when rent settles, and finalized by the month-end cron. */}
      {!liveLedgerEnabled && !statementId && !summariesQuery.isLoading && (
        <div className="space-y-4">
          <Callout variant="info" title="No statement issued yet">
            Nothing has been issued for {humanMonth(month)}. The management fee is billed
            automatically when a tenant's rent is fully paid, and the month's final statement is
            produced after the month ends — there is nothing to issue by hand.
          </Callout>
          {!summaryRow?.hasData && (
            <EmptyState
              icon={FileText}
              title="No billing data"
              description="There are no posted ledger entries for this month. Post charges first; the statement follows automatically."
            />
          )}
        </div>
      )}

      {/* Live ledger view — FLAG ON, no statement issued yet. The admin sees the
          month's FULL detail computed straight from the posted ledger WITHOUT
          issuing: a top-line summary card followed by the SAME 5 section
          sub-components an issued statement shows (issuing now only formalizes
          the PDF). Only genuinely-empty months show an empty state; when a
          statement HAS been issued, the issued-path render above takes over. */}
      {liveLedgerEnabled && !statementId && !summariesQuery.isLoading && (
        summaryRow?.hasData ? (
          <div className="space-y-6">
            <LiveLedgerSummary row={summaryRow} month={month} />
            {liveSections ? (
              <StatementSectionsView
                sections={liveSections}
                ownerPartyId={ownerPartyId}
                month={month}
              />
            ) : (
              !liveSectionsQuery.isError && <PageSkeleton />
            )}
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title="No activity this month"
            description="There are no posted ledger entries for this month yet."
          />
        )
      )}

      {/* 5-section statement — issued path (statementId set). The SAME
          sub-components render for the live path below via StatementSectionsView. */}
      {statementId && sections && (
        <StatementSectionsView sections={sections} ownerPartyId={ownerPartyId} month={month} />
      )}

      {/* Loading sections (statementId known but sections not yet fetched) */}
      {statementId && !sections && !sectionsQuery.isError && (
        <PageSkeleton />
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * The full 5-section statement body — shared by the ISSUED path (statementId set)
 * and the LIVE path (flag on, no statement issued yet). Both feed IDENTICAL
 * YannieSections; issuing changes only whether a formal PDF exists, not what the
 * five sections show. Extracting this keeps the two views byte-identical (same
 * sub-components, same per-expense proof + Bills & Proof panel).
 */
function StatementSectionsView({
  sections,
  ownerPartyId,
  month,
}: {
  sections: YannieSections;
  ownerPartyId: string;
  month: string;
}) {
  return (
    <div className="space-y-6">
      {/* Section 1 — Statement Details */}
      <StatementSectionHeader data={sections.header} />

      {/* Section 2 — Occupancy */}
      <StatementSectionOccupancy data={sections.occupancy} />

      {/* Section 3 — Payout Summary */}
      <StatementSectionPayoutSummary data={sections.payoutSummary} />

      {/* Section 4 — Income Breakdown */}
      <StatementSectionIncome data={sections.incomeBreakdown} />

      {/* Section 5 — Expense Breakdown. Bills attach PER expense row (apartment +
          category scoped) — the apartmentId comes from the sections payload, which
          is populated for the live path too, so per-row proof works pre-issue. */}
      <StatementSectionExpenses
        data={sections.expenseBreakdown}
        ownerPartyId={ownerPartyId}
        statementMonth={month}
        apartmentId={sections.apartmentId}
        editable
      />

      {/* Bills & Proof (C2) — the consolidated, downloadable proof pack, kept
          SEPARATE from the clean statement. Admin = editable (attach/detach). */}
      <AdminBillsProofPanel
        ownerPartyId={ownerPartyId}
        statementMonth={month}
        apartmentId={sections.apartmentId ?? null}
      />
    </div>
  );
}

/**
 * Live Ledger Summary (Task 9) — shown when the live-ledger flag is ON and the
 * month has posted activity but no statement has been issued yet. The figures
 * (gross rental / total expenses / net payout) are read straight from
 * summaryRow, which the API computes live from the posted ledger regardless of
 * whether a statement Invoice exists. Visual style mirrors the issued
 * statement's Payout Summary section (glass Card + inner stat blocks + gold
 * GlowCard net-payout highlight) so the pre- and post-issue views feel like one
 * product. Issuing produces the formal statement document; it is no longer a
 * prerequisite for seeing these numbers.
 */
function LiveLedgerSummary({
  row,
  month,
}: {
  row: MonthlyStatementSummary;
  month: string;
}) {
  const gross = Number(row.grossRental);
  const expenses = Number(row.totalExpenses);
  const net = Number(row.netPayoutToOwner);
  const isNegative = !isNaN(net) && net < 0;

  return (
    <div className="space-y-4">
      <Callout variant="info" title="Live figures">
        These totals are computed live from the posted ledger for {humanMonth(month)} and move as
        money lands. "Print PDF" above gives you these exact figures at any time. The month's
        final, frozen statement is produced automatically after the month ends.
      </Callout>

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Live Ledger Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Gross rental + total expenses — inner stat blocks */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">Gross Rental</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-500">
                {isNaN(gross) ? "RM 0.00" : formatRM(gross)}
              </p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">Total Expenses</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
                {isNaN(expenses) ? "RM 0.00" : formatRM(expenses)}
              </p>
            </div>
          </div>

          {/* Net payout highlight — matches the issued statement's Payout Summary */}
          <GlowCard
            glowColor="gold"
            className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Net Payout to Owner</p>
                <p
                  className={`text-3xl font-bold tabular-nums ${
                    isNegative
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-amber-600 dark:text-amber-500"
                  }`}
                >
                  {isNaN(net) ? "RM 0.00" : formatRM(net)}
                </p>
                {isNegative && (
                  <p className="text-xs text-rose-600 dark:text-rose-400">
                    Negative — KAEN has fronted the shortfall
                  </p>
                )}
              </div>
              <div className="p-3 rounded-xl bg-amber-500/10">
                <DollarSign className="h-6 w-6 text-amber-600" />
              </div>
            </div>
          </GlowCard>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Admin Bills & Proof panel (C2): fetches the per-expense bills for this statement's
 * (owner, month, apartment) and renders the shared ProofPackPanel EDITABLE — attach/
 * detach per category + a "Download all bills" action that streams the merged
 * proof-pack PDF (C1). Distinct from the per-row bill column in Section 5: this is the
 * consolidated, downloadable proof bundle, kept off the clean financial statement.
 */
function AdminBillsProofPanel({
  ownerPartyId,
  statementMonth,
  apartmentId,
}: {
  ownerPartyId: string;
  statementMonth: string;
  apartmentId: string | null;
}) {
  const proofsQuery = useExpenseProofs(ownerPartyId, statementMonth, apartmentId);
  const attach = useAttachExpenseProof();
  const detach = useDetachExpenseProof();
  const [downloading, setDownloading] = useState(false);

  const scope = { ownerPartyId, statementMonth, apartmentId };

  async function handleDownloadAll() {
    setDownloading(true);
    try {
      await downloadProofPack(scope);
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
      editable
      downloading={downloading}
      attaching={attach.isPending}
      detaching={detach.isPending}
      onDownloadAll={handleDownloadAll}
      onAttach={(category, files) =>
        attach.mutate(
          { ...scope, category, files },
          {
            onSuccess: (rows) =>
              toast.success(rows.length === 1 ? "Bill attached." : `${rows.length} bills attached.`),
            onError: (err) => toast.error(err.message),
          },
        )
      }
      onDetach={(proofId) =>
        detach.mutate(proofId, {
          onSuccess: () => toast.success("Bill detached."),
          onError: (err) => toast.error(err.message),
        })
      }
    />
  );
}

function BackCrumb({ ownerPartyId }: { ownerPartyId: string }) {
  return (
    <div>
      <Link
        to={`/tenancy/owner-ledger/${ownerPartyId}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to owner workspace
      </Link>
    </div>
  );
}

/**
 * Two buttons, both read-only. Nothing here issues, approves or sends — those are
 * the cron's job now (see this file's header comment for why the manual triggers
 * were removed).
 *
 * Print PDF is the primary action and carries NO enabling condition beyond the
 * endpoint existing: it renders live from the ledger, so it works on a month with
 * no statement, a draft one, or a frozen one alike.
 */
function ActionButtons({
  canPrintPdf,
  canViewPdf,
  isPrintingPdf,
  isViewingPdf,
  onPrintPdf,
  onViewPdf,
}: {
  canPrintPdf: boolean;
  canViewPdf: boolean;
  isPrintingPdf: boolean;
  isViewingPdf: boolean;
  onPrintPdf: () => void;
  onViewPdf: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {/* Print PDF — the working copy, always available, figures as they stand */}
      {canPrintPdf && (
        <Button variant="gold" disabled={isPrintingPdf} onClick={onPrintPdf}>
          <Printer className="h-4 w-4" />
          {isPrintingPdf ? "Preparing…" : "Print PDF"}
        </Button>
      )}

      {/* View issued PDF — the formal owner copy, only once one has been rendered */}
      {canViewPdf && (
        <Button variant="outline" size="sm" disabled={isViewingPdf} onClick={onViewPdf}>
          <Download className="h-4 w-4" /> {isViewingPdf ? "Opening…" : "View issued PDF"}
        </Button>
      )}
    </div>
  );
}
