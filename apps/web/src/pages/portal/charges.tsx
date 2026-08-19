import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";

type ChargeItem = {
  id: string; chargeNumber: string; chargeType: string; description: string | null;
  status: string; dueDate: string; amount: number; outstandingAmount: number; currency: string;
  /** Bill number the tenant was sent, null when not yet on a bill. Never render
   * `chargeNumber` in its place — see chargeReference below. */
  documentNumber?: string | null;
};

/**
 * What to print in the reference column. `chargeNumber` is an internal key that
 * embeds raw UUIDs for grid-minted rows (`GRIDUTIL-202608-6727b8fb-…-ELECTRICITY`),
 * so a tenant looking for their invoice number saw gibberish. Falls back to the
 * charge's own description, then an em dash — anything but the internal id.
 */
function chargeReference(c: ChargeItem): string {
  return c.documentNumber ?? c.description ?? "—";
}

type PaginatedResponse = {
  data: ChargeItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export default function PortalChargesPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["portal-charges", page],
    queryFn: () => portalApiFetch<PaginatedResponse>(`/charges?page=${page}&limit=20`),
  });

  if (isLoading) return <div className="animate-pulse text-sm text-[var(--text-secondary)]">Loading...</div>;

  const charges = data?.data ?? [];
  const pagination = data?.pagination;

  const multiPayEnabled = isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Charges</h1>
        {multiPayEnabled && (
          <Link
            to="/portal/pay"
            className="rounded-md bg-[var(--gold)] px-4 py-2 text-sm font-medium text-[var(--gold-fg)]"
          >
            Pay charges
          </Link>
        )}
      </div>

      <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--page-bg)]">
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Charge #</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Due Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-secondary)]">Amount</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-secondary)]">Outstanding</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-secondary)]">Status</th>
            </tr>
          </thead>
          <tbody>
            {charges.map((c) => (
              <tr key={c.id} className="border-b border-[var(--page-bg)] last:border-0 hover:bg-accent">
                <td className="px-4 py-3">
                  <Link to={`/portal/charges/${c.id}`} className="text-[var(--gold)] hover:underline">{chargeReference(c)}</Link>
                </td>
                <td className="px-4 py-3 text-[var(--text-primary)]">{c.chargeType}</td>
                <td className="px-4 py-3 text-[var(--text-secondary)]">{c.dueDate.slice(0, 10)}</td>
                <td className="px-4 py-3 text-right text-[var(--text-primary)]">MYR {c.amount.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-[var(--text-primary)]">MYR {c.outstandingAmount.toFixed(2)}</td>
                <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
          <span>Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 rounded border border-[var(--input-border)] disabled:opacity-30">Prev</button>
            <button onClick={() => setPage((p) => p + 1)} disabled={page >= pagination.totalPages} className="px-3 py-1 rounded border border-[var(--input-border)] disabled:opacity-30">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    posted: "bg-sky-500/10 text-sky-400",
    partial: "bg-amber-500/10 text-amber-400",
    partially_paid: "bg-amber-500/10 text-amber-400",
    paid: "bg-emerald-500/10 text-emerald-400",
    void: "bg-slate-500/10 text-slate-400",
    draft: "bg-slate-500/10 text-slate-400",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-slate-500/10 text-slate-400"}`}>
      {status}
    </span>
  );
}
