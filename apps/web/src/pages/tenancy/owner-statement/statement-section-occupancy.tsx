// Section 2 — Occupancy
// Table: unit code, tenant, tenancy start/end, monthly rental, deposit.
// Vacant rows are marked with a "Vacant" badge; occupied rows show tenant name.
import { HomeIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRM, formatDate } from "@/components/format";
import type { YannieSections } from "@/api/owner-ledger";

interface Props {
  data: YannieSections["occupancy"];
}

export function StatementSectionOccupancy({ data }: Props) {
  // DEV guard: required fields per frontend-design rule #16
  if (import.meta.env.DEV) {
    if (data.rows === undefined)
      console.warn("[owner-statement/occupancy] missing rows from API response");
    if (data.totalMonthlyRental === undefined)
      console.warn("[owner-statement/occupancy] missing totalMonthlyRental from API response");
  }

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-occupancy">
            <HomeIcon className="h-5 w-5 text-primary" />
            Occupancy
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="emerald" className="text-xs">
              {data.occupiedCount} occupied
            </Badge>
            {data.vacantCount > 0 && (
              <Badge variant="sky" className="text-xs">
                {data.vacantCount} vacant
              </Badge>
            )}
          </div>
        </div>
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
                  Tenancy Period
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Monthly Rental
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Deposit
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={`${row.unitCode}-${i}`}
                  className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                >
                  <td className="px-4 py-3.5 text-sm font-medium text-[var(--text-primary)]">
                    {row.unitCode}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                    {row.isVacant ? (
                      <Badge variant="sky" className="text-xs">Vacant</Badge>
                    ) : (
                      row.tenantName ?? <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-xs text-muted-foreground tabular-nums">
                    {row.tenancyStart
                      ? `${formatDate(row.tenancyStart)} – ${row.tenancyEnd ? formatDate(row.tenancyEnd) : "ongoing"}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums font-semibold text-foreground">
                    {formatRM(Number(row.monthlyRental))}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums text-muted-foreground">
                    {Number(row.depositAmount) > 0
                      ? `${formatRM(Number(row.depositAmount))}${row.depositMonths ? ` (${row.depositMonths} ${row.depositMonths > 1 ? "months" : "month"})` : ""}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-background/40">
              <tr>
                <td colSpan={3} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Total monthly rental
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm font-bold text-foreground">
                  {formatRM(Number(data.totalMonthlyRental))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
