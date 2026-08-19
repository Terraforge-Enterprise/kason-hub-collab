// Section 4 — Income Breakdown
// Table: unit, tenant, income type, billing period, amount, mgmt fee, mgmt fee SST, payment status.
// paymentStatus column uses a StatusPill (Badge variant from getStatusTone).
import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRM } from "@/components/format";
import { getStatusTone } from "@/components/format";
import { StatusPill } from "@/components/ui";
import type { YannieSections } from "@/api/owner-ledger";

interface Props {
  data: YannieSections["incomeBreakdown"];
}

export function StatementSectionIncome({ data }: Props) {
  // DEV guard: required fields per frontend-design rule #16
  if (import.meta.env.DEV) {
    if (data.rows === undefined)
      console.warn("[owner-statement/income] missing rows from API response");
    if (data.totalIncome === undefined)
      console.warn("[owner-statement/income] missing totalIncome from API response");
  }

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-income">
          <TrendingUp className="h-5 w-5 text-primary" />
          Income Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Unit
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Tenant
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Period
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Amount
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Mgmt Fee
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  SST
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={`income-${i}`}
                  className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                >
                  <td className="px-4 py-3.5 text-sm font-medium text-[var(--text-primary)]">
                    {row.unitCode}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                    {row.tenantName ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <Badge variant="sky" className="text-xs">
                      {row.incomeType}
                    </Badge>
                    {/* WHICH utility this line is — "Electricity (TNB)", "Water (Air
                        Selangor)", "WiFi"… Several rows share one badge, so without
                        this they are indistinguishable to the owner reading them. */}
                    {row.detail && (
                      <div
                        data-testid={`income-row-detail-${i}`}
                        className="text-xs font-medium text-[var(--text-primary)] mt-1"
                      >
                        {row.detail}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-muted-foreground">
                    {row.billingPeriod}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums">
                    {/* Primary: charged (billed) amount; falls back to collected when chargedAmount absent.
                        A pass-through row is the tenant's own utility bill, and an informational row is rent
                        KAEN retained as commission — neither is owner earnings, so both render muted rather
                        than in the income green so they never read as money the owner receives. */}
                    <span
                      data-testid={`income-row-charged-${i}`}
                      className={
                        row.isPassThrough || row.isInformational
                          ? "font-semibold text-muted-foreground"
                          : "font-semibold text-emerald-600 dark:text-emerald-500"
                      }
                    >
                      {formatRM(Number(row.chargedAmount ?? row.amount))}
                    </span>
                    {/* Secondary: muted "Collected RM x" when not fully paid AND amounts differ
                        (matches PDF logic: no redundant line when charged === collected) */}
                    {row.paymentStatus !== "paid" && row.chargedAmount != null && Number(row.chargedAmount) !== Number(row.amount) && (
                      <div
                        data-testid={`income-row-collected-${i}`}
                        className="text-[11px] text-muted-foreground mt-0.5"
                      >
                        Collected {formatRM(Number(row.amount))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums text-rose-600 dark:text-rose-400">
                    {Number(row.mgmtFee) > 0
                      ? formatRM(Number(row.mgmtFee))
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums text-muted-foreground">
                    {Number(row.mgmtFeeSst) > 0
                      ? formatRM(Number(row.mgmtFeeSst))
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusPill tone={getStatusTone(row.paymentStatus)}>
                      {row.paymentStatus}
                    </StatusPill>
                    {/* "Paid to supplier" read as a lie on a pending row — the tenant
                        has not paid yet, so nothing has reached the supplier. This
                        wording is true in every payment state. */}
                    {row.isPassThrough && (
                      <div
                        data-testid={`income-row-passthrough-${i}`}
                        className="text-[11px] text-muted-foreground mt-1"
                      >
                        Not part of payout
                      </div>
                    )}
                    {/* Without this the owner reads a commission month as RM 0.00 income
                        next to an unexplained owner-borne SST deduction. The ledger
                        already records WHY (row.detail); this is the only surface that
                        shows it.

                        The copy BRANCHES on incomeType because the two informational
                        kinds mean opposite things about the payout. "Retained by KAEN"
                        is true of letting commission — that money never reaches the
                        owner. It would be a LIE on an Extra Electricity row: that spread
                        IS the owner's and already reached them, as Aircond Fee minus the
                        master TNB expense. It is listed separately only so they can see
                        where the difference came from, never as a second payment. */}
                    {row.isInformational && (
                      <div
                        data-testid={`income-row-informational-${i}`}
                        className="text-[11px] text-muted-foreground mt-1"
                      >
                        {row.incomeType === "Extra Electricity"
                          ? "Already included in your payout"
                          : "Retained by KAEN — not part of payout"}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-background/40">
              <tr>
                <td colSpan={4} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Total income collected
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm font-bold text-foreground">
                  {formatRM(Number(data.totalIncome))}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm font-bold text-rose-600 dark:text-rose-400">
                  {formatRM(Number(data.totalMgmtFee))}
                </td>
                <td colSpan={2} />
              </tr>
              {/* Tenant utilities KAEN collected and forwarded to the supplier. Footed
                  separately so the owner can see what their tenant was charged without
                  it ever reading as income — it is excluded from Total income collected
                  and from the payout. */}
              {Number(data.passThroughIncome ?? 0) > 0 && (
                <tr data-testid="income-passthrough-total">
                  <td colSpan={4} className="px-4 pb-3 text-xs text-muted-foreground">
                    Tenant utilities collected &amp; paid to suppliers (not part of your payout)
                  </td>
                  <td className="px-4 pb-3 text-right tabular-nums text-sm font-semibold text-muted-foreground">
                    {formatRM(Number(data.passThroughIncome))}
                  </td>
                  <td colSpan={3} />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
