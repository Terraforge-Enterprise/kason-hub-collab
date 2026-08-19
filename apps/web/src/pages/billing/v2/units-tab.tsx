// apps/web/src/pages/billing/v2/units-tab.tsx
// Units tab (spec §3.2): month charges grouped by unit / carpark bay /
// unassigned. Unbilled units are NOT listed — the tracker owns the billing
// run; a quiet link points there. Unit headers deep-link to the owner-ledger
// unit workspace via group.apartmentId (charge.unitId is a Listing id — never
// use it for that route).
//
// Settlement bands (charges register clarity Spec 1, R1/R2/R3/R5): charges
// render grouped by settlement `track` in flow order — Tenant fees →
// Pass-through → Owner charges — each with a Σ amount subtotal, and
// zero-value rows collapsed behind a "+N zero-value line(s)" expander. The
// header pill is single-basis: `toCollect` sums outstandingAmount over
// tenant_fees + pass_through rows ONLY. Owner charges settle by netting
// against the owner payout, never by tenant collection, so they are
// deliberately excluded from `toCollect` (see headerPill) — this exclusion
// must never be re-derived.
//
// Deviation from the design brief: the pill's money figure uses `formatRM`,
// not this file's usual `formatMoney`. `formatMoney(1500)` renders
// "1,500 MYR" (no "RM" substring — verified directly and cross-checked
// against `allocate-drawer.test.tsx`'s existing `/100 MYR/` assertion),
// which cannot satisfy the "RM<amount> to collect" acceptance criteria.
// `formatRM` is the existing (if previously unused-in-v2) helper that
// actually renders the "RM" prefix. Everything else in this file keeps
// `formatMoney`, matching the established convention elsewhere in billing v2.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, ReceiptText } from "lucide-react";
import { Surface, StatusPill } from "@/components/ui";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { UnitChip } from "@/pages/tasks/unit-chip";
import { formatMoney, formatRM, getStatusTone } from "@/components/format";
import { useChargesGrouped, type ChargeGroup, type GroupedChargeRow } from "./use-billing-v2";
import { ChargeRowMenu } from "./charge-row-menu";

const TRACK_BANDS: { track: GroupedChargeRow["track"]; label: string }[] = [
  { track: "tenant_fees", label: "Tenant fees" },
  { track: "pass_through", label: "Pass-through — collected from tenant → owner" },
  { track: "owner", label: "Owner charges — deducted from payout" },
];

/**
 * Single-basis settlement pill. `toCollect` sums outstandingAmount over
 * tenant_fees + pass_through rows only — owner charges settle by netting,
 * not tenant collection, so they're excluded. Never re-derive this filter.
 */
export function headerPill(charges: GroupedChargeRow[]) {
  const toCollect = charges
    .filter((c) => c.track !== "owner")
    .reduce((s, c) => s + c.outstandingAmount, 0);
  return toCollect === 0
    ? { tone: "emerald" as const, label: "Settled" }
    : { tone: "amber" as const, label: `${formatRM(toCollect)} to collect` };
}

function ChargeRow({ r }: { r: GroupedChargeRow }) {
  return (
    <tr className="border-b border-[var(--card-border)] last:border-b-0 hover:bg-[var(--page-bg)]">
      <td className="px-4 py-3.5 font-medium text-[var(--text-primary)]" title={r.chargeNumber}>
        {r.documentNumber ?? r.chargeNumber}
      </td>
      <td className="px-4 py-3.5">{r.categoryLabel}</td>
      <td className="px-4 py-3.5 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
      <td className="px-4 py-3.5 text-right tabular-nums">{formatMoney(r.outstandingAmount)}</td>
      <td className="px-4 py-3.5">
        <StatusPill tone={getStatusTone(r.displayStatus)}>{r.displayStatus.replace(/_/g, " ")}</StatusPill>
      </td>
      <td className="px-4 py-3.5 text-right"><ChargeRowMenu charge={r} /></td>
    </tr>
  );
}

function Band({ label, rows }: { label: string; rows: GroupedChargeRow[] }) {
  const [showZero, setShowZero] = useState(false);
  const zero = rows.filter((r) => r.amount === 0);
  const nonZero = rows.filter((r) => r.amount !== 0);
  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <>
      <tr className="bg-[var(--page-bg)]">
        <td colSpan={5} className="px-4 py-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-secondary)]">{label}</td>
        <td className="px-4 py-2 text-right text-xs font-semibold tabular-nums">{formatMoney(subtotal)}</td>
      </tr>
      {nonZero.map((r) => <ChargeRow key={r.id} r={r} />)}
      {zero.length > 0 && !showZero && (
        <tr><td colSpan={6} className="px-4 py-2">
          <button type="button" className="text-xs text-[var(--text-secondary)] hover:underline" onClick={() => setShowZero(true)}>
            ＋ {zero.length} zero-value line{zero.length > 1 ? "s" : ""}
          </button>
        </td></tr>
      )}
      {showZero && zero.map((r) => <ChargeRow key={r.id} r={r} />)}
    </>
  );
}

function GroupCard({ group }: { group: ChargeGroup }) {
  const pill = headerPill(group.charges);
  const bands = TRACK_BANDS
    .map((b) => ({ ...b, rows: group.charges.filter((c) => c.track === b.track) }))
    .filter((b) => b.rows.length > 0);
  return (
    <details open className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3">
        <UnitChip unit={{ unitCode: group.label, propertyName: group.propertyName }} />
        {group.apartmentId ? (
          <Link
            to={`/tenancy/owner-ledger/unit/${group.apartmentId}`}
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-sm font-semibold text-[var(--text-primary)] hover:underline"
          >
            {group.label}
          </Link>
        ) : (
          <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{group.label}</span>
        )}
        {group.subtitle && <span className="text-sm text-[var(--text-secondary)]">{group.subtitle}</span>}
        <span className="ml-auto flex items-center gap-3">
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          <span className="text-sm font-semibold tabular-nums">{formatMoney(group.totals.amount)}</span>
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-[var(--card-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              <th className="px-4 py-2">Document</th><th className="px-4 py-2">Category</th>
              <th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2 text-right">Outstanding</th>
              <th className="px-4 py-2">Status</th><th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => <Band key={b.track} label={b.label} rows={b.rows} />)}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function UnitsTab({ month }: { month: string }) {
  const grouped = useChargesGrouped(month, "unit");

  if (grouped.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-24 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-24 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }
  if (grouped.isError) {
    return (
      <Callout variant="danger" title="Couldn't load unit charges">
        <Button size="sm" variant="outline" onClick={() => grouped.refetch()}>Retry</Button>
      </Callout>
    );
  }

  const groups = grouped.data?.groups ?? [];
  return (
    <Surface
      title={`Units — ${month}`}
      description="Tenant billing grouped per unit. Unbilled units aren't listed — bill units from the Tenant & Owner Billing grid."
    >
      <div className="mb-3 text-xs">
        <Link to="/billing/tenant-owner-billing" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> Bill a unit → Tenant & Owner Billing
        </Link>
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No charges for this month"
          description="Nothing has been billed in this month yet. Bill units from the Tenant & Owner Billing grid."
        />
      ) : (
        <div className="space-y-3" aria-busy={grouped.isPlaceholderData}>
          {groups.map((g) => <GroupCard key={g.key} group={g} />)}
        </div>
      )}
    </Surface>
  );
}
