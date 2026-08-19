import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Surface } from "@/components/ui";
import { formatMoney } from "@/components/format";
import { listInFlightFpx, cancelInFlightFpx } from "@/api/payments";

const IN_FLIGHT_FPX_KEY = ["payments", "fpx-in-flight"] as const;

/** Minutes → "42m" / "3h 5m" for the age column. */
function formatAge(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Mirrors payments-table.tsx's ReverseAllocationButton: a small inline rose
// action with its own pending + error state. Cancelling an in-flight FPX
// attempt never touches charges (it never settled), so no confirm dialog — same
// low-stakes treatment as Reverse on this page.
function CancelButton({ paymentId }: { paymentId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const cancelMutation = useMutation({
    mutationFn: () => cancelInFlightFpx(paymentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: IN_FLIGHT_FPX_KEY });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        className="text-xs text-rose-600 underline underline-offset-2 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={cancelMutation.isPending}
        onClick={() => {
          setError(null);
          cancelMutation.mutate();
        }}
      >
        {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}

/**
 * Admin section listing the org's in-flight FPX payments (tenant attempts still
 * awaiting the gateway callback) with a per-row Cancel. The default payments
 * listing hides these gatewayStatus="pending" rows, so this is the only admin
 * surface for genuinely stuck attempts. Renders nothing while loading, on error,
 * or when there are none — it appears only when there is something to act on.
 */
export function InFlightFpxSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: IN_FLIGHT_FPX_KEY,
    queryFn: () => listInFlightFpx(),
  });

  const rows = data?.data ?? [];
  if (isLoading || isError || rows.length === 0) return null;

  return (
    <Surface
      title="In-flight FPX payments"
      description="Tenant FPX attempts still awaiting the gateway callback. Cancel only ones the payer clearly abandoned — charges are never touched."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Payment #</th>
              <th className="px-3 py-2 font-semibold">Payer</th>
              <th className="px-3 py-2 font-semibold text-right">Amount</th>
              <th className="px-3 py-2 font-semibold text-right">Age</th>
              <th className="px-3 py-2 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/30 last:border-0">
                <td className="px-3 py-2.5 font-medium text-foreground">{r.paymentNumber}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.partyName}</td>
                <td className="px-3 py-2.5 text-right text-foreground">{formatMoney(r.amount, r.currency)}</td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">{formatAge(r.ageMinutes)}</td>
                <td className="px-3 py-2.5 text-right">
                  <CancelButton paymentId={r.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}
