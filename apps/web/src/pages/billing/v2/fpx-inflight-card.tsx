// apps/web/src/pages/billing/v2/fpx-inflight-card.tsx
// Same data flow as in-flight-fpx-section.tsx (legacy Payments page) but
// restyled onto standard v2 tokens + a Callout wrapper. Self-hides while
// loading, on error, and when there are zero in-flight rows — it appears
// only when there is genuinely something to act on.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listInFlightFpx, cancelInFlightFpx } from "@/api/payments";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/components/format";

export function FpxInFlightCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["payments", "fpx-in-flight"], queryFn: listInFlightFpx });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelInFlightFpx(id),
    onSuccess: () => {
      toast.success("FPX attempt cancelled");
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (e: Error) => toast.error(e.message || "Cancel failed"),
  });
  const rows = q.data?.data ?? [];
  if (q.isLoading || q.isError || rows.length === 0) return null;
  return (
    <Callout variant="warning" title={`In-flight FPX (${rows.length})`}>
      <p className="mb-2 text-xs">
        Tenant FPX attempts awaiting the bank. They settle automatically — cancel only genuinely abandoned ones.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
              <th className="px-2 py-1">Payment #</th><th className="px-2 py-1">Payer</th>
              <th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1">Age</th><th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[var(--card-border)]">
                <td className="px-2 py-1.5 font-medium">{r.paymentNumber}</td>
                <td className="px-2 py-1.5">{r.partyName}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-2 py-1.5">{r.ageMinutes < 60 ? `${r.ageMinutes}m` : `${Math.floor(r.ageMinutes / 60)}h`}</td>
                <td className="px-2 py-1.5 text-right">
                  <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                    Cancel
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Callout>
  );
}
