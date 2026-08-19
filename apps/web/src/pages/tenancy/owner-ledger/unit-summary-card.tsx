// UnitSummaryCard — one unit's month payout figures + its actions (Task 8 / D3).
//
// ONE responsibility: render a single unit's four month figures (Income Collected ·
// Deposit Collected · Deductible Expenses · Net Payout) plus, for a real apartment,
// the two per-unit actions ("Print Invoice" + "Attach bills").
//
// The figures come straight from useUnitsSummary (Task 5), whose values are the
// REAL computeOwnerPayout outputs — so they FOOT (income + deposit − deductible
// === net) and agree with the statement.
//
// Two scopes:
//   • Real apartment (apartmentId != null) — shows Print Invoice (the bills-merged
//     receipt from Task 4, scoped to this unit+month) and Attach bills (opens
//     <BulkBillAttach> from Task 7 in a side panel, scoped to this unit+month).
//   • "Unassigned / property-level" sentinel (apartmentId == null) — figures only;
//     there's no apartment to scope a receipt or a bill attach to, so no actions.
//
// Design: GlowCard (glowColor="gold") to match the Owner Workspace summary cards —
// financial totals use gold (frontend-design §2). Net Payout is the highlight;
// deductibles render in rose.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DollarSign,
  FileText,
  Home,
  Paperclip,
  Printer,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { GlowCard } from "@/components/ui/glow-card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { formatRM } from "@/components/format";
import { downloadLedgerReceipt, type UnitPayoutRow } from "@/api/owner-ledger";
import { useExpenseProofs } from "@/api/owner-billing";
import { BulkBillAttach } from "./bulk-bill-attach";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  unit: UnitPayoutRow;
  ownerPartyId: string;
  /** "YYYY-MM" — the billing month these figures cover. */
  month: string;
}

// ─── Figure row ──────────────────────────────────────────────────────────────────

function FigureRow({
  icon: Icon,
  label,
  value,
  tone = "foreground",
  emphasised = false,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  tone?: "foreground" | "rose" | "gold";
  emphasised?: boolean;
}) {
  const amount = Number(value);
  const valueColor =
    tone === "gold"
      ? amount < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-amber-600 dark:text-amber-400"
      : tone === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";

  return (
    <div
      className={
        emphasised
          ? "flex items-center justify-between border-t border-border/30 pt-2"
          : "flex items-center justify-between"
      }
    >
      <div
        className={
          emphasised
            ? "flex items-center gap-1.5 text-sm font-semibold text-foreground"
            : "flex items-center gap-1.5 text-xs text-muted-foreground"
        }
      >
        <Icon
          className={
            emphasised
              ? "h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
              : "h-3 w-3"
          }
        />
        <span>{label}</span>
      </div>
      <p
        className={`tabular-nums ${
          emphasised ? "text-base font-bold" : "text-sm font-semibold"
        } ${valueColor}`}
      >
        {formatRM(Number.isNaN(amount) ? 0 : amount)}
      </p>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function UnitSummaryCard({ unit, ownerPartyId, month }: Props) {
  const isReal = unit.apartmentId != null;
  const navigate = useNavigate();
  const [attachOpen, setAttachOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Proof count badge: total attached files (photos, PDFs, bills) for this
  // unit+month.  Pass undefined for ownerPartyId/month when the card is the
  // sentinel so the query stays disabled (apartmentId null also disables it
  // server-side, but disabling client-side avoids an unnecessary request).
  const { data: proofsData } = useExpenseProofs(
    isReal ? ownerPartyId : undefined,
    isReal ? month : undefined,
    unit.apartmentId,
  );
  const proofCount = isReal
    ? (proofsData?.data ?? []).flatMap((g) => g.proofs).length
    : 0;

  async function handlePrint() {
    if (unit.apartmentId == null) return;
    setDownloading(true);
    try {
      await downloadLedgerReceipt(ownerPartyId, month, unit.apartmentId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not download the invoice.",
      );
    } finally {
      setDownloading(false);
    }
  }

  function handleCardClick() {
    if (!isReal) return;
    navigate(`/tenancy/owners/${ownerPartyId}/units/${unit.apartmentId}/statements/${month}`);
  }

  function handleCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCardClick();
    }
  }

  return (
    <GlowCard
      glowColor="gold"
      className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
    >
      <div className="space-y-4">
        {/* Clickable region: unit heading + figures + cue.
            For a real apartment this is a keyboard-accessible affordance that
            navigates to the full per-unit statement. The sentinel bucket keeps
            the same visual layout but is NOT interactive. */}
        <div
          role={isReal ? "button" : undefined}
          tabIndex={isReal ? 0 : undefined}
          onClick={isReal ? handleCardClick : undefined}
          onKeyDown={isReal ? handleCardKeyDown : undefined}
          aria-label={isReal ? `View full statement for ${unit.unitCode}` : undefined}
          className={isReal ? "cursor-pointer space-y-4 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" : "space-y-4"}
        >
          {/* Unit heading */}
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-amber-500/10 p-1.5">
              <Home className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            </span>
            <p className="text-sm font-semibold text-foreground">{unit.unitCode}</p>
          </div>

          {/* Four figures — these foot: income + deposit − deductible === net */}
          <div className="space-y-2">
            <FigureRow
              icon={TrendingUp}
              label="Income Collected"
              value={unit.incomeCollected}
            />
            <FigureRow
              icon={Wallet}
              label="Deposit Collected"
              value={unit.depositCollected}
            />
            <FigureRow
              icon={TrendingDown}
              label="Deductible Expenses"
              value={unit.deductibleExpenses}
              tone="rose"
            />
            <FigureRow
              icon={DollarSign}
              label="Net Payout"
              value={unit.netPayout}
              tone="gold"
              emphasised
            />
          </div>

          {/* "View full statement →" cue — visible hint that the card body is clickable. */}
          {isReal && (
            <p className="text-right text-xs text-amber-600 dark:text-amber-400">
              View full statement →
            </p>
          )}
        </div>

        {/* Per-unit actions — sibling to the clickable region, NOT nested inside it,
            so clicks here do not trigger card-body navigation.
            Real apartment only: sentinel has no apartment to scope receipts to. */}
        {isReal && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={downloading}
                onClick={handlePrint}
                title="Download an itemized invoice PDF (with bills) for this unit and month"
              >
                <Printer className="h-4 w-4" />
                {downloading ? "Downloading…" : "Print Invoice"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setAttachOpen(true)}
                title="Attach supporting bills for this unit and month"
              >
                <Paperclip className="h-4 w-4" />
                Attach bills
                {proofCount > 0 && (
                  <span
                    data-testid="attachment-count-badge"
                    className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                  >
                    {proofCount}
                  </span>
                )}
              </Button>
            </div>
            {/* Per-unit statement — open this apartment's statement page to view its
                figures or generate/save the per-unit statement for accounting. Admin
                only: per-unit statements never reach the owner portal (the owner sees
                just the combined "All Units" statement). */}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() =>
                navigate(
                  `/tenancy/owners/${ownerPartyId}/units/${unit.apartmentId}/statements/${month}`,
                )
              }
              title="Open this unit's statement — view figures or generate/save the per-unit statement"
            >
              <FileText className="h-4 w-4" />
              Per-unit statement
            </Button>
          </div>
        )}
      </div>

      {/* Attach-bills side panel — mounts BulkBillAttach scoped to this unit+month.
          Only reachable for a real apartment (button is gated above), so the
          non-null assertion below is safe. */}
      {isReal && (
        <Sheet open={attachOpen} onOpenChange={(o) => !o && setAttachOpen(false)}>
          <SheetContent size="md">
            <SheetHeader>
              <SheetTitle>Attach bills · {unit.unitCode}</SheetTitle>
              <SheetDescription>
                Drop supporting bills (TNB, water, wifi, cleaning…) for this unit in
                this month. They appear on the receipt and statement.
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <BulkBillAttach
                ownerPartyId={ownerPartyId}
                month={month}
                apartmentId={unit.apartmentId!}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </GlowCard>
  );
}
