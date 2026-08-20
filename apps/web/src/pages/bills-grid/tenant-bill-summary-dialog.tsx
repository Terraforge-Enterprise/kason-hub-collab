import { useEffect, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import type { GridRow, GridSubRow } from "@/api/bills-grid";
import { usePartyOpenCharges } from "@/api/charges";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateMY, formatRM } from "@/components/format";

type TenantOption = Pick<GridSubRow, "partyId" | "partyName" | "tenancyId">;

export function TenantBillSummaryDialog({ row, onClose }: { row: GridRow | null; onClose: () => void }) {
  const tenants = useMemo(
    () => (row?.subRows ?? []).filter((sub): sub is GridSubRow & { partyId: string } => Boolean(sub.partyId)),
    [row],
  );
  const [partyId, setPartyId] = useState<string | null>(null);

  useEffect(() => setPartyId(tenants[0]?.partyId ?? null), [row?.apartmentId]);

  const selected: TenantOption | undefined = tenants.find((tenant) => tenant.partyId === partyId);
  const chargesQuery = usePartyOpenCharges(partyId);
  const charges = chargesQuery.data ?? [];
  const total = charges.reduce((sum, charge) => sum + charge.outstandingAmount, 0);

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[var(--navy-text)]">
            <Eye className="h-5 w-5 text-[var(--gold)]" />
            Tenant bill summary · {row?.unitCode}
          </DialogTitle>
        </DialogHeader>

        {tenants.length > 1 && (
          <label className="block text-sm font-medium text-[var(--navy-text)]">
            Tenant
            <select
              value={partyId ?? ""}
              onChange={(event) => setPartyId(event.target.value)}
              className="mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[var(--navy-text)] focus:outline-none focus:ring-2 focus:ring-[var(--gold)]"
            >
              {tenants.map((tenant) => <option key={tenant.partyId} value={tenant.partyId}>{tenant.partyName ?? "Tenant"}</option>)}
            </select>
          </label>
        )}

        <div className="rounded-xl bg-[var(--navy)] px-5 py-4 text-white">
          <p className="text-sm text-white/75">What {selected?.partyName ?? "this tenant"} sees as Current balance</p>
          <p className="mt-1 text-3xl font-bold text-[var(--gold-light)]">{formatRM(total)}</p>
          <p className="mt-1 text-xs text-white/70">Total of all tenant-visible outstanding charges, including partially paid balances.</p>
        </div>

        <div className="max-h-[50vh] overflow-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead className="sticky top-0 bg-[var(--table-header)] text-[var(--navy-text)]">
              <tr>
                <th className="px-3 py-2 text-left">Bill</th>
                <th className="px-3 py-2 text-left">Billing period</th>
                <th className="px-3 py-2 text-left">Due date</th>
                <th className="px-3 py-2 text-left">Details</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Original</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {chargesQuery.isLoading && <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">Loading tenant data…</td></tr>}
              {chargesQuery.isError && <tr><td colSpan={8} className="px-3 py-8 text-center text-red-600">Couldn&apos;t load this tenant&apos;s bill summary.</td></tr>}
              {!chargesQuery.isLoading && !chargesQuery.isError && charges.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No outstanding charges. The tenant sees RM 0.00.</td></tr>}
              {charges.map((charge) => (
                <tr key={charge.id} className="border-t border-[var(--border)]">
                  <td className="max-w-[150px] break-words px-3 py-2 font-semibold text-[var(--navy-text)]">{charge.documentNumber ?? charge.invoiceNumber ?? charge.chargeNumber}</td>
                  <td className="whitespace-nowrap px-3 py-2">{charge.billingMonth ? new Date(charge.billingMonth).toLocaleDateString("en-MY", { month: "long", year: "numeric", timeZone: "UTC" }) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDateMY(charge.dueDate)}</td>
                  <td className="min-w-[180px] px-3 py-2"><div className="font-semibold text-[var(--navy-text)]">{charge.description || charge.chargeType}</div>{charge.description && <div className="text-xs capitalize text-muted-foreground">{charge.chargeType.replaceAll("_", " ")}</div>}</td>
                  <td className="px-3 py-2 capitalize">{charge.status.replaceAll("_", " ")}</td>
                  <td className="px-3 py-2 text-right">{formatRM(charge.amount)}</td>
                  <td className="px-3 py-2 text-right text-emerald-700">{formatRM(Math.max(0, charge.amount - charge.outstandingAmount))}</td>
                  <td className="px-3 py-2 text-right font-bold text-[var(--navy-text)]">{formatRM(charge.outstandingAmount)}</td>
                </tr>
              ))}
            </tbody>
            {charges.length > 0 && <tfoot><tr className="bg-[var(--navy)] font-bold text-[var(--gold-light)]"><td colSpan={7} className="px-3 py-3 text-right">Total Outstanding</td><td className="px-3 py-3 text-right">{formatRM(total)}</td></tr></tfoot>}
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Draft and void charges are excluded. A partially paid charge contributes only its remaining outstanding balance.</p>
      </DialogContent>
    </Dialog>
  );
}
