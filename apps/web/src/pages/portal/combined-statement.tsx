import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Workstream E, Part 5 — combined TENANT statement, grouped by UNIT CONTEXT and
// de-identified: the tenant sees one statement split per unit / carpark, each
// heading labelled by the apartment's unit code or "Carpark" — NEVER the owner's
// name (PDPA, fix #5). Residential rent groups under the home unit; a rented
// carpark under "Carpark". Grand total across groups. Rendered view (no PDF —
// see workstream-E-report.md).

type StatementLine = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  description: string | null;
  status: string;
  dueDate: string;
  amount: number;
  /** CN/DN-adjusted amount (2026-08-06) — optional so an older API still parses. */
  adjustedAmount?: number;
  outstandingAmount: number;
  currency: string;
};

type StatementGroup = {
  // Grouped + labelled by UNIT context (unit code / "Carpark"). No owner
  // identity is sent to the tenant (PDPA #5) — see portal.statement.repository.
  groupKey: string;
  groupLabel: string;
  lines: StatementLine[];
  subtotal: number;
  outstandingSubtotal: number;
};

type CombinedStatement = {
  month: string;
  monthLabel: string;
  currency: string;
  groups: StatementGroup[];
  total: number;
  outstandingTotal: number;
};

function money(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function prettyChargeType(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// Per-line settlement-status pill. Reuses the shared Badge component for visual
// parity with the rest of the portal (no inline colour classes). Mapping per the
// tenant-statement spec: paid→emerald, partial→amber, posted/pending→sky (not
// yet settled = info), overdue→rose (the design system's red family), draft→
// slate (Badge has no slate variant → "secondary", its muted equivalent — same
// fallback the portal dashboard uses). Tenant-facing labels translate the
// internal "posted" state to the clearer "Pending".
type StatusBadgeVariant = "emerald" | "amber" | "sky" | "rose" | "secondary";

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
  paid: "emerald",
  partially_paid: "amber",
  partial: "amber",
  posted: "sky",
  pending: "sky",
  overdue: "rose",
  draft: "secondary",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  partially_paid: "Partial",
  partial: "Partial",
  posted: "Pending",
  pending: "Pending",
  overdue: "Overdue",
  draft: "Draft",
};

function StatusPill({ status }: { status: string }) {
  const key = status.toLowerCase();
  return (
    <Badge variant={STATUS_VARIANT[key] ?? "secondary"}>
      {STATUS_LABEL[key] ?? prettyChargeType(status)}
    </Badge>
  );
}

export default function PortalCombinedStatementPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(currentMonth());
  const { data, isLoading } = useQuery({
    queryKey: ["portal-combined-statement", month],
    queryFn: () =>
      portalApiFetch<{ data: CombinedStatement }>(`/charges/statement?month=${month}`),
  });

  const statement = data?.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Statement</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            Your charges for the month, grouped by unit.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          Month
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
            className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>
      </div>

      {isLoading && (
        <div className="animate-pulse text-sm text-[var(--text-secondary)]">Loading…</div>
      )}

      {!isLoading && statement && statement.groups.length === 0 && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
          No charges for {statement.monthLabel}.
        </div>
      )}

      {!isLoading && statement && statement.groups.length > 0 && (
        <>
          {statement.groups.map((group) => (
            <div
              key={group.groupKey}
              className="overflow-hidden rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--page-bg)] px-4 py-3">
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {group.groupLabel}
                </div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {money(group.subtotal, statement.currency)}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--page-bg)]">
                    <th className="px-4 py-2 text-left text-xs font-medium text-[var(--text-secondary)]">Charge</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-[var(--text-secondary)]">Due</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--text-secondary)]">Amount</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-[var(--text-secondary)]">Outstanding</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-[var(--text-secondary)]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {group.lines.map((line) => (
                    <tr key={line.id} className="border-b border-[var(--page-bg)] last:border-0">
                      <td className="px-4 py-2 text-[var(--text-primary)]">
                        {prettyChargeType(line.chargeType)}
                        <span className="ml-2 text-xs text-[var(--text-secondary)]">{line.chargeNumber}</span>
                      </td>
                      <td className="px-4 py-2 text-[var(--text-secondary)]">{line.dueDate.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-right text-[var(--text-primary)]">
                        {/* CN/DN-adjusted — matches the subtotal/total basis the server sums. */}
                        {money(line.adjustedAmount ?? line.amount, statement.currency)}
                      </td>
                      <td className="px-4 py-2 text-right text-[var(--text-primary)]">
                        {money(line.outstandingAmount, statement.currency)}
                      </td>
                      <td className="px-4 py-2">
                        <StatusPill status={line.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Total for {statement.monthLabel}</div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-base font-bold text-[var(--text-primary)]">
                  {money(statement.total, statement.currency)}
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Outstanding {money(statement.outstandingTotal, statement.currency)}
                </div>
              </div>
              {statement.outstandingTotal > 0 && (
                <Button variant="gold" onClick={() => navigate("/portal/pay")}>
                  Pay outstanding ({money(statement.outstandingTotal, statement.currency)})
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
