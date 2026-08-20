import type { GridRow } from "@/api/bills-grid";
import { useLiveStatementSections, useOwnerMonthlySummaries, useStatementSections } from "@/api/owner-ledger";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatementSectionHeader } from "@/pages/tenancy/owner-statement/statement-section-header";
import { StatementSectionOccupancy } from "@/pages/tenancy/owner-statement/statement-section-occupancy";
import { StatementSectionPayoutSummary } from "@/pages/tenancy/owner-statement/statement-section-payout-summary";
import { StatementSectionIncome } from "@/pages/tenancy/owner-statement/statement-section-income";
import { StatementSectionExpenses } from "@/pages/tenancy/owner-statement/statement-section-expenses";
import { useApproveStatement, useFirstCheckStatement, useGenerateStatement } from "@/api/owner-billing";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function OwnerReportDialog({ row, month, onClose }: { row: GridRow | null; month: string; onClose: () => void }) {
  const ownerPartyId = row?.ownerPartyId ?? undefined;
  const apartmentId = row?.apartmentId;
  const summaries = useOwnerMonthlySummaries(ownerPartyId, apartmentId);
  const monthSummary = summaries.data?.data.items.find((item) => item.month === month);
  const statementId = monthSummary?.statementId ?? undefined;
  const statementStatus = monthSummary?.statementStatus ?? "draft";
  const generate = useGenerateStatement();
  const firstCheck = useFirstCheckStatement();
  const approve = useApproveStatement();
  const issued = useStatementSections(statementId);
  const live = useLiveStatementSections(statementId ? undefined : ownerPartyId, statementId ? undefined : month, apartmentId);
  const sections = issued.data?.data ?? live.data?.data;
  const loading = summaries.isLoading || issued.isLoading || live.isLoading;
  const failed = summaries.isError || issued.isError || live.isError;
  const changingStatus = generate.isPending || firstCheck.isPending || approve.isPending;

  async function markFirstChecked() {
    if (!row || !ownerPartyId) return;
    try {
      const id = statementId ?? (await generate.mutateAsync({ ownerPartyId, billingMonth: month, apartmentId: row.apartmentId })).data.id;
      await firstCheck.mutateAsync(id);
      toast.success("Owner payout marked First Checked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not mark this report First Checked");
    }
  }

  async function markApproved() {
    if (!statementId) return;
    try {
      await approve.mutateAsync(statementId);
      toast.success("Owner payout approved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not approve this owner payout");
    }
  }

  return (
    <Dialog open={row != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1200px)] max-w-none overflow-y-auto p-5 sm:p-7">
        <DialogHeader>
          <DialogTitle className="text-2xl text-[var(--navy-text)]">
            Owner Monthly Report · {row?.propertyName} {row?.unitCode}
          </DialogTitle>
          <p className="text-base text-[var(--text-secondary)]">
            {month} · Preview of the report available to this owner
          </p>
        </DialogHeader>

        {!ownerPartyId ? (
          <div className="rounded-xl border border-amber-400 bg-amber-50 p-6 text-center text-base font-semibold text-amber-900">
            No owner is assigned to this unit yet.
          </div>
        ) : loading && !sections ? (
          <div className="space-y-4 py-4 animate-pulse">
            <div className="h-28 rounded-xl bg-[var(--page-bg)]" />
            <div className="h-40 rounded-xl bg-[var(--page-bg)]" />
            <div className="h-48 rounded-xl bg-[var(--page-bg)]" />
          </div>
        ) : failed && !sections ? (
          <div className="rounded-xl border border-red-400 bg-red-50 p-6 text-center text-base font-semibold text-red-800">
            Could not load this owner report. The unit may not have posted owner-ledger activity for this month yet.
          </div>
        ) : sections ? (
          <div className="space-y-5 pt-2" data-testid="owner-report-sections">
            <StatementSectionHeader data={sections.header} />
            <StatementSectionOccupancy data={sections.occupancy} />
            <StatementSectionPayoutSummary data={sections.payoutSummary} />
            <StatementSectionIncome data={sections.incomeBreakdown} />
            <StatementSectionExpenses
              data={sections.expenseBreakdown}
              ownerPartyId={ownerPartyId}
              statementMonth={month}
              apartmentId={sections.apartmentId}
              editable={false}
            />
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--page-bg)] p-8 text-center text-base text-[var(--text-secondary)]">
            No owner report activity is available for this unit and month yet.
          </div>
        )}
        {ownerPartyId && sections && (
          <div className="sticky bottom-0 flex justify-end border-t border-[var(--border)] bg-white/95 pt-4 backdrop-blur">
            {statementStatus === "first_checked" ? (
              <Button className="min-h-12 px-6 text-lg font-bold" disabled={changingStatus} onClick={() => void markApproved()}>
                {approve.isPending ? "Approving…" : "Approved"}
              </Button>
            ) : !["approved", "sent", "paid"].includes(statementStatus) ? (
              <Button className="min-h-12 px-6 text-lg font-bold" disabled={changingStatus} onClick={() => void markFirstChecked()}>
                {changingStatus ? "Saving…" : "First Checked"}
              </Button>
            ) : (
              <span className="rounded-lg border border-emerald-600 bg-[#00FF00] px-5 py-3 text-lg font-extrabold text-[var(--navy-text)]">Approved</span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
