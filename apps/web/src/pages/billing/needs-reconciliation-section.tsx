import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { formatMoney } from "@/components/format";
import {
  listNeedsReconciliation,
  resolveNeedsReconciliation,
  type NeedsReconciliationItem,
} from "@/api/payments";

const QUEUE_KEY = ["payments", "needs-reconciliation"] as const;

/** Hours → "6h" / "3d 4h", so an aging liability reads at a glance. */
function formatAge(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Resolve one row. Deliberately two explicit buttons rather than a dropdown:
 * "apply it" and "write it off" are opposite money decisions and should not sit
 * one mis-click apart behind the same control.
 */
function ResolveRow({ item }: { item: NeedsReconciliationItem }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<null | "settle" | "dismiss">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (action: "settle" | "dismiss") => resolveNeedsReconciliation(item.id, { action, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      setOpen(null);
      setReason("");
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) {
    return (
      <span className="inline-flex gap-3">
        <button
          type="button"
          className="text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
          onClick={() => { setOpen("settle"); setError(null); }}
        >
          Apply payment
        </button>
        <button
          type="button"
          className="text-xs text-rose-600 underline underline-offset-2 hover:text-rose-800"
          onClick={() => { setOpen("dismiss"); setError(null); }}
        >
          Not received
        </button>
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <label className="sr-only" htmlFor={`reason-${item.id}`}>
        Reason for {open === "settle" ? "applying" : "dismissing"} {item.paymentNumber}
      </label>
      <textarea
        id={`reason-${item.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder={
          open === "settle"
            ? "What confirms the money arrived? (e.g. seen on the bank statement 14 Aug)"
            : "What confirms it did NOT arrive? (e.g. no credit on the statement, gateway shows reversed)"
        }
        className="w-72 rounded border border-border bg-background p-2 text-xs"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={open === "settle" ? "default" : "destructive"}
          disabled={reason.trim().length < 10 || mutation.isPending}
          onClick={() => { setError(null); mutation.mutate(open); }}
        >
          {mutation.isPending ? "Saving…" : open === "settle" ? "Confirm & apply" : "Confirm not received"}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2"
          onClick={() => { setOpen(null); setReason(""); setError(null); }}
        >
          Cancel
        </button>
      </div>
      {reason.trim().length > 0 && reason.trim().length < 10 && (
        <span className="text-xs text-muted-foreground">A few more words — this is kept for the audit trail.</span>
      )}
      {error && <span className="text-xs text-rose-600 max-w-72 text-right">{error}</span>}
    </div>
  );
}

/**
 * Admin queue for payments the bank confirmed but that could not be applied
 * automatically.
 *
 * Unlike the in-flight FPX panel beside it, this section renders its ERROR state
 * rather than disappearing. An in-flight list that fails to load is a nuisance; a
 * liability list that fails to load looks exactly like "nothing owed", which is
 * the one thing it must never be mistaken for.
 */
export function NeedsReconciliationSection() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => listNeedsReconciliation(),
  });

  if (isLoading) return null;

  if (isError) {
    return (
      <Callout variant="danger" title="Couldn't load payments awaiting reconciliation">
        {(error as Error)?.message || "Something went wrong."} This list can contain money that has
        left a tenant's account — please retry rather than assuming it is empty.
      </Callout>
    );
  }

  const rows = data?.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Surface
      title="Payments awaiting reconciliation"
      description="The bank confirmed these after they had already been closed off, so they were not applied automatically. The payer has most likely been debited."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Payment</th>
              <th className="py-2 pr-4 font-medium">Payer</th>
              <th className="py-2 pr-4 font-medium text-right">Amount</th>
              <th className="py-2 pr-4 font-medium">Waiting</th>
              <th className="py-2 pr-4 font-medium">Closed by</th>
              <th className="py-2 font-medium text-right">Resolve</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/50 last:border-0 align-top">
                <td className="py-3 pr-4 font-medium">{r.paymentNumber}</td>
                <td className="py-3 pr-4">{r.partyName}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{formatMoney(r.amount, r.currency)}</td>
                <td className="py-3 pr-4 tabular-nums">{formatAge(r.ageHours)}</td>
                <td className="py-3 pr-4 text-muted-foreground">
                  {r.closedBy === "admin" ? "Cancelled here" : "Failed at gateway"}
                </td>
                <td className="py-3 text-right">
                  <ResolveRow item={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Check the bank statement before choosing. Applying credits the tenant; marking it not received
        leaves the charge open. Either way your reason is recorded against the payment.
      </p>
    </Surface>
  );
}
