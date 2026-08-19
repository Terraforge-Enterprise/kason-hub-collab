// apps/web/src/pages/billing/v2/all-tab.tsx
import { useState } from "react";
import { Search } from "lucide-react";
import { useChargesList } from "./use-billing-v2";
import { ChargeRowMenu } from "./charge-row-menu";
import { StatusPill, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { PillBar } from "@/components/ui/pill-bar";
import { formatDate, formatMoney, getStatusTone } from "@/components/format";

const STATUS_PILLS = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "paid", label: "Paid" },
  { value: "credited", label: "Credited" },
  { value: "void", label: "Void" },
];
const PARTY_PILLS = [
  { value: "", label: "Tenant + owner" },
  { value: "tenant", label: "Tenant-billed" },
  { value: "owner", label: "Owner-billed" },
];

export function AllChargesTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState(""); // optional — show-all-first

  const list = useChargesList({
    page,
    status: status || undefined,
    counterparty: (counterparty || undefined) as "tenant" | "owner" | undefined,
    month: month || undefined,
    q: q || undefined,
  });

  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 25));

  return (
    <Surface title="All charges" description="Every billing row, all time. Filters are server-side.">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <PillBar
          value={status ? [status] : [""]}
          onChange={(next) => { setStatus(next[next.length - 1] ?? ""); setPage(1); }}
          options={STATUS_PILLS}
          ariaLabel="Filter by status"
          size="sm"
        />
        <PillBar
          value={counterparty ? [counterparty] : [""]}
          onChange={(next) => { setCounterparty(next[next.length - 1] ?? ""); setPage(1); }}
          options={PARTY_PILLS}
          ariaLabel="Filter by counterparty"
          size="sm"
        />
        <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
          <Search className="h-3.5 w-3.5" />
          <input
            className="rounded-md border border-[var(--card-border)] bg-transparent px-2 py-1 text-sm"
            placeholder="Charge # or party…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </label>
        <label className="flex items-center gap-1 text-xs uppercase tracking-wide text-[var(--text-secondary)]">
          Month
          <input
            type="month"
            className="rounded-md border border-[var(--card-border)] bg-transparent px-2 py-1 text-sm"
            value={month}
            onChange={(e) => { setMonth(e.target.value); setPage(1); }}
          />
        </label>
      </div>

      <div className="overflow-x-auto" aria-busy={list.isPlaceholderData}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              <th className="px-4 py-2">Charge #</th><th className="px-4 py-2">Party</th>
              <th className="px-4 py-2">Unit</th><th className="px-4 py-2">Category</th>
              <th className="px-4 py-2">Document</th><th className="px-4 py-2">Due</th>
              <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2">Status</th><th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className={list.isPlaceholderData ? "opacity-60" : ""}>
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-[var(--text-secondary)]">No charges match.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--card-border)] hover:bg-[var(--page-bg)]">
                <td className="px-4 py-3.5 font-medium text-[var(--text-primary)]">{r.chargeNumber}</td>
                <td className="px-4 py-3.5">{r.partyName}</td>
                <td className="px-4 py-3.5">{r.unitCode ?? "-"}</td>
                <td className="px-4 py-3.5">{r.chargeType}</td>
                <td className="px-4 py-3.5">{r.documentNumber ?? "—"}</td>
                <td className="px-4 py-3.5">{formatDate(r.dueDate)}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">{formatMoney(r.outstandingAmount)}</td>
                <td className="px-4 py-3.5">
                  <StatusPill tone={getStatusTone(r.displayStatus)}>{r.displayStatus.replace(/_/g, " ")}</StatusPill>
                </td>
                <td className="px-4 py-3.5 text-right">
                  <ChargeRowMenu charge={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
        <span>Page {page} of {pageCount} — {total} charge(s)</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>
    </Surface>
  );
}
