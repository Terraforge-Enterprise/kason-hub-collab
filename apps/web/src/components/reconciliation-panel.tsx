// Read-only owner-payable reconciliation waterfall (Phase 3, R15/R18 of
// docs/superpowers/specs/2026-07-20-rental-reclassification-owner-payable-completion-design.md).
// Design: docs/superpowers/specs/2026-07-21-owner-reconciliation-panel-design.md
//
// Shared component: rendered in the owner portal today (owner-statement.tsx),
// deliberately self-contained (owns its own query + loading/error state, no
// props plumbing required) so a future admin view can reuse it unchanged.
import {
  ArrowUp,
  ArrowDown,
  CircleCheck,
  TriangleAlert,
  Lock,
  Scale,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { formatCents } from "@/components/format";
import { cn } from "@/lib/utils";
import {
  usePortalOwnerReconciliation,
  type OwnerPayableReconciliation,
} from "@/api/portal-owner-statements";

type WaterfallRowKind = "anchor-open" | "increase" | "decrease" | "anchor-close";

type WaterfallRow = {
  key: string;
  label: string;
  /**
   * Expected to be an unsigned magnitude in cents (sign/color/icon are
   * derived from `kind`, not from this value's sign) — but the type system
   * cannot enforce that on API data, so `WaterfallTableRow` defensively
   * displays `Math.abs(amountC)`: a contract-violating negative value can
   * never render a self-contradictory glyph (e.g. a green "+" arrow next to
   * a negative amount). It can still throw off that row's own running-total
   * delta if the server genuinely sends a signed value here — this defends
   * the single-cell display, not full cross-column arithmetic consistency
   * against a malformed backend.
   */
  amountC: number;
  kind: WaterfallRowKind;
  /** Running total AFTER this row, in cents. */
  runningTotalC: number;
};

/**
 * Builds the 7 waterfall rows per R15's formula:
 *   Opening + collections − offsets − pass-through − remittances + reversals = Closing
 * Intermediate running totals are LOCALLY accumulated from openingPayableC
 * (the API does not provide per-row running totals). The closing row's
 * running total is always the AUTHORITATIVE `closingPayableC` from the
 * server — deliberately NOT the locally-accumulated sum, so an unbalanced
 * period visibly shows a different final total than the local math implies,
 * reinforcing the separate balance indicator (never hidden behind a
 * misleadingly "balanced-looking" total).
 */
function buildWaterfallRows(data: OwnerPayableReconciliation): WaterfallRow[] {
  let running = data.openingPayableC;
  const rows: WaterfallRow[] = [
    {
      key: "opening",
      label: "Opening payable",
      amountC: data.openingPayableC,
      kind: "anchor-open",
      runningTotalC: running,
    },
  ];

  const steps: Array<{ key: string; label: string; amountC: number; sign: 1 | -1 }> = [
    { key: "collections", label: "Collections received", amountC: data.collectionsC, sign: 1 },
    { key: "offsets", label: "Offset settlements", amountC: data.offsetDeductionsC, sign: -1 },
    {
      key: "pass-through",
      label: "Pass-through expenses",
      amountC: data.passThroughExpensesC,
      sign: -1,
    },
    { key: "remittances", label: "Gross remittances", amountC: data.grossRemittancesC, sign: -1 },
    { key: "reversals", label: "Reversals & corrections", amountC: data.reversalsC, sign: 1 },
  ];

  for (const step of steps) {
    running += step.sign * step.amountC;
    rows.push({
      key: step.key,
      label: step.label,
      amountC: step.amountC,
      kind: step.sign === 1 ? "increase" : "decrease",
      runningTotalC: running,
    });
  }

  rows.push({
    key: "closing",
    label: "Closing payable",
    amountC: data.closingPayableC,
    kind: "anchor-close",
    runningTotalC: data.closingPayableC,
  });

  return rows;
}

/** "2026-07" → current-wall-clock default when no month is supplied. */
function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function WaterfallTableRow({ row }: { row: WaterfallRow }) {
  const isAnchor = row.kind === "anchor-open" || row.kind === "anchor-close";
  const isIncrease = row.kind === "increase";
  const isDecrease = row.kind === "decrease";
  const Icon = isIncrease ? ArrowUp : isDecrease ? ArrowDown : null;
  const sign = isIncrease ? "+" : isDecrease ? "−" : "";

  return (
    <tr
      className={cn(
        "border-b border-border/30 last:border-b-0",
        row.kind === "anchor-close" && "border-t-2 border-t-border font-bold",
      )}
    >
      <td
        className={cn(
          "py-2.5 px-3 text-sm",
          isAnchor ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {row.label}
      </td>
      <td className="py-2.5 px-3 text-sm text-right tabular-nums">
        {isAnchor ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center justify-end gap-1",
              isIncrease && "text-emerald-600 dark:text-emerald-400",
              isDecrease && "text-rose-600 dark:text-rose-400",
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />} {sign} {formatCents(Math.abs(row.amountC))}
          </span>
        )}
      </td>
      <td
        className={cn(
          "py-2.5 px-3 text-sm text-right tabular-nums text-foreground",
          isAnchor && "font-bold text-base",
        )}
      >
        {formatCents(row.runningTotalC)}
      </td>
    </tr>
  );
}

function ReconciliationSkeleton() {
  return (
    <div
      className="space-y-6 animate-pulse motion-reduce:animate-none"
      data-testid="reconciliation-panel-skeleton"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-24 bg-muted rounded-2xl" />
        <div className="h-24 bg-muted rounded-2xl" />
      </div>
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}

export function ReconciliationPanel({ month }: { month?: string }) {
  const resolvedMonth = month ?? currentMonthKey();
  const query = usePortalOwnerReconciliation(resolvedMonth);
  const data = query.data?.data;

  if (query.isLoading) return <ReconciliationSkeleton />;
  if (query.isError || !data) {
    return (
      <Callout variant="danger" title="Couldn't load your reconciliation">
        Please refresh the page or try again shortly. If it keeps failing, contact
        your property manager.
      </Callout>
    );
  }

  const rows = buildWaterfallRows(data);

  return (
    <div className="space-y-6" data-testid="reconciliation-panel">
      {/* R18 — frozen vs remaining-now */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlowCard
          glowColor="blue"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                Net payable at statement close
              </p>
              {data.frozenNetPayableAtCloseC === null ? (
                <>
                  <p className="text-2xl font-bold text-muted-foreground tabular-nums mt-2">—</p>
                  <p className="text-xs text-muted-foreground">Not yet frozen</p>
                </>
              ) : (
                <p
                  className="text-2xl font-bold text-foreground tabular-nums mt-2"
                  data-testid="frozen-net-payable-value"
                >
                  {formatCents(data.frozenNetPayableAtCloseC)}
                </p>
              )}
            </div>
            {data.frozenNetPayableAtCloseC !== null && (
              <Badge variant="secondary">
                <Lock className="h-3 w-3" aria-hidden="true" /> Frozen
              </Badge>
            )}
          </div>
        </GlowCard>

        <GlowCard
          glowColor="gold"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Remaining payable now</p>
              <p
                className="text-2xl font-bold text-foreground tabular-nums mt-2"
                data-testid="remaining-payable-now-value"
              >
                {formatCents(data.remainingPayableNowC)}
              </p>
            </div>
            <span className="relative flex h-2.5 w-2.5 mt-1 shrink-0" aria-hidden="true">
              <span className="motion-reduce:hidden animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
            </span>
          </div>
        </GlowCard>
      </div>
      <p className="text-xs text-muted-foreground">
        Subsequent settlements after the freeze are reflected in &ldquo;remaining now&rdquo;, never
        in the frozen figure.
      </p>

      {/* Balance indicator */}
      {data.balanced ? (
        <Badge variant="emerald">
          <CircleCheck className="h-3 w-3" aria-hidden="true" /> Reconciled
        </Badge>
      ) : (
        <div role="alert">
          <Callout variant="danger" title="Figures don't reconcile" icon={TriangleAlert}>
            {Number.isFinite(data.discrepancyC) && data.discrepancyC !== 0
              ? `Discrepancy of ${formatCents(Math.abs(data.discrepancyC))}.`
              : "Please contact your property manager."}
          </Callout>
        </div>
      )}

      {/* Waterfall table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Scale className="h-5 w-5 text-primary" aria-hidden="true" />
            Payable Reconciliation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full border-collapse">
              <caption className="sr-only">
                Owner payable reconciliation for {data.periodMonth}, from opening payable through
                closing payable
              </caption>
              <thead>
                <tr className="border-b border-border/50 bg-background/40">
                  <th scope="col" className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                    Line
                  </th>
                  <th scope="col" className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                    Movement
                  </th>
                  <th scope="col" className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                    Running total
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <WaterfallTableRow key={row.key} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
