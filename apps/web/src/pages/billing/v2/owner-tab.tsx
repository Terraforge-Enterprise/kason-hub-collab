// apps/web/src/pages/billing/v2/owner-tab.tsx
// Owner billing tab (spec §3.3): month's owner-side charges grouped by
// statement. Children display "on statement" (derived) — they settle by
// payout netting, never by posting. Unattached = invoiceId-null owner rows.
import { FileText, Landmark } from "lucide-react";
import { toast } from "sonner";
import { Surface, StatusPill } from "@/components/ui";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { fetchBillingDocumentPdfUrl } from "@/api/billing-documents";
import { formatMoney, getStatusTone } from "@/components/format";
import { useChargesGrouped, type ChargeGroup } from "./use-billing-v2";
import { ChargeRowMenu } from "./charge-row-menu";

function StatementCard({ group }: { group: ChargeGroup }) {
  async function openIvownPdf() {
    if (!group.ivownDocumentId) return;
    try {
      const url = await fetchBillingDocumentPdfUrl(group.ivownDocumentId);
      window.open(url, "_blank", "noopener");
    } catch {
      toast.error("Could not fetch the statement invoice PDF");
    }
  }
  return (
    <details open className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3">
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{group.label}</span>
        {group.subtitle && <span className="text-sm text-[var(--text-secondary)]">{group.subtitle}</span>}
        {group.statementStatus && (
          <StatusPill tone={getStatusTone(group.statementStatus)}>{group.statementStatus}</StatusPill>
        )}
        <span className="ml-auto flex items-center gap-3">
          {group.ivownDocumentNumber && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); void openIvownPdf(); }}
              className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline"
            >
              <FileText className="h-3.5 w-3.5" /> {group.ivownDocumentNumber}
            </button>
          )}
          <span className="text-sm font-semibold tabular-nums">{formatMoney(group.totals.amount)}</span>
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-[var(--card-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              <th className="px-4 py-2">Charge #</th><th className="px-4 py-2">Category</th>
              <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {group.charges.map((r) => (
              <tr key={r.id} className="border-b border-[var(--card-border)] last:border-b-0 hover:bg-[var(--page-bg)]">
                <td className="px-4 py-3.5 font-medium text-[var(--text-primary)]">{r.chargeNumber}</td>
                <td className="px-4 py-3.5">{r.categoryLabel ?? r.chargeType}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-4 py-3.5">
                  <StatusPill tone={getStatusTone(r.displayStatus)}>{r.displayStatus.replace(/_/g, " ")}</StatusPill>
                </td>
                <td className="px-4 py-3.5 text-right"><ChargeRowMenu charge={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function OwnerBillingTab({ month }: { month: string }) {
  const grouped = useChargesGrouped(month, "statement");

  if (grouped.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-24 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }
  if (grouped.isError) {
    return (
      <Callout variant="danger" title="Couldn't load owner billing">
        <Button size="sm" variant="outline" onClick={() => grouped.refetch()}>Retry</Button>
      </Callout>
    );
  }
  const groups = grouped.data?.groups ?? [];
  return (
    <Surface
      title={`Owner billing — ${month}`}
      description="Owner statement lines and standalone owner charges. Lines settle via payout netting on the statement."
    >
      {groups.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No owner billing this month"
          description="Generate statements from Owner Statements to bill owners for this month."
        />
      ) : (
        <div className="space-y-3">{groups.map((g) => <StatementCard key={g.key} group={g} />)}</div>
      )}
    </Surface>
  );
}
