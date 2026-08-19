// apps/web/src/pages/billing/v2/allocate-drawer.tsx
// Allocate additional charges to an EXISTING posted payment (spec §4). Same
// payer-scoped charge-picker as RecordPaymentDrawer, minus the payer/method/
// type/date fields — those are already fixed on the posted payment. One
// idempotencyKey per drawer-open (useRef) so a retry after a network error
// REPLAYS instead of double-allocating. Client-side caps the ticked Σ at the
// payment's REMAINING headroom (amount - already-allocated), not its full
// amount — a payment that already carries prior allocations (partial payer,
// or a batch this drawer previously submitted) has less room than its face
// value. The server re-checks this, this is UX only.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { allocateBatch } from "@/api/payments";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/form-ui";
import { formatMoney } from "@/components/format";
import { usePayerOutstandingCharges } from "./use-billing-v2";
import type { PaymentMenuRow } from "./payment-row-menu";

export function AllocateDrawer({
  payment,
  onOpenChange,
}: {
  payment: PaymentMenuRow | null;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const idemKeyRef = useRef<string>(crypto.randomUUID());
  const [picked, setPicked] = useState<Map<string, string>>(new Map());

  const open = payment !== null;
  // Remaining headroom, not the payment's full face value — a payment that
  // already carries allocations (Finding 3, final-review fix wave) has less
  // room than payment.amount.
  const cap = Math.max(0, (payment?.amount ?? 0) - (payment?.allocatedTotal ?? 0));
  const currency = payment?.currency ?? "MYR";
  const pool = usePayerOutstandingCharges(open ? payment!.partyId : null);

  const total = useMemo(
    () => [...picked.values()].reduce((s, v) => s + (Number(v) || 0), 0),
    [picked],
  );

  function resetAfterClose() {
    idemKeyRef.current = crypto.randomUUID();
    setPicked(new Map());
  }

  // Remaining headroom under the payment's own amount, excluding `excludeId`'s
  // current contribution (so re-clamping a charge already ticked doesn't count
  // itself twice). Always derived from the `map` passed in — a state-updater
  // reading the outer `picked` closure instead of its own `prev` can act on
  // stale totals, which would let Σ drift past `cap`.
  function headroomFrom(map: Map<string, string>, excludeId?: string): number {
    const others = [...map.entries()].reduce(
      (s, [id, v]) => (id === excludeId ? s : s + (Number(v) || 0)),
      0,
    );
    return Math.max(0, cap - others);
  }

  function toggle(chargeId: string, outstanding: number) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(chargeId)) {
        next.delete(chargeId);
        return next;
      }
      const room = headroomFrom(prev);
      if (room <= 0) return prev; // no capacity left under the payment's amount — ignore the tick
      next.set(chargeId, Math.min(outstanding, room).toFixed(2));
      return next;
    });
  }
  function setAmount(chargeId: string, raw: string) {
    setPicked((prev) => new Map(prev).set(chargeId, raw));
  }
  function clampAmount(chargeId: string, outstanding: number) {
    setPicked((prev) => {
      const next = new Map(prev);
      const n = Number(next.get(chargeId));
      let clamped = !Number.isFinite(n) || n <= 0 ? 0.01 : Math.min(n, outstanding);
      clamped = Math.min(clamped, headroomFrom(prev, chargeId));
      next.set(chargeId, clamped.toFixed(2));
      return next;
    });
  }

  const submit = useMutation({
    mutationFn: () =>
      allocateBatch(
        payment!.id,
        idemKeyRef.current,
        [...picked.entries()].map(([chargeId, allocatedAmount]) => ({
          chargeId,
          allocatedAmount: Number(allocatedAmount).toFixed(2),
        })),
      ),
    onSuccess: () => {
      toast.success(`Allocated ${formatMoney(total, currency)} to ${picked.size} charge(s)`);
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["billing"] });
      onOpenChange(false);
      resetAfterClose();
    },
    onError: (e: Error) => toast.error(e.message || "Allocation failed — nothing was saved."),
  });

  const rows = pool.data?.data ?? [];

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetAfterClose(); }}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Allocate {payment?.paymentNumber}</SheetTitle>
          <SheetDescription>
            Tick the charges this payment covers — the total can&apos;t exceed the payment&apos;s remaining {formatMoney(cap, currency)}.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Outstanding charges</p>
            {pool.isLoading && <div className="h-16 animate-pulse rounded-lg bg-[var(--card-bg)]" />}
            {!pool.isLoading && rows.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">This payer has nothing outstanding.</p>
            )}
            {rows.map((c) => (
              <label key={c.id} className="flex items-center gap-2 rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={c.chargeNumber}
                  checked={picked.has(c.id)}
                  onChange={() => toggle(c.id, c.outstandingAmount)}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.chargeNumber}</span>
                  <span className="ml-2 text-xs text-[var(--text-secondary)]">
                    {c.unitCode ?? ""} · outstanding {formatMoney(c.outstandingAmount)}
                  </span>
                </span>
                {picked.has(c.id) && (
                  <TextInput
                    aria-label={`Amount for ${c.chargeNumber}`}
                    className="w-24 text-right"
                    inputMode="decimal"
                    value={picked.get(c.id) ?? ""}
                    onChange={(e) => setAmount(c.id, e.target.value)}
                    onBlur={() => clampAmount(c.id, c.outstandingAmount)}
                  />
                )}
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--card-border)] pt-3">
            <span className="text-sm text-[var(--text-secondary)]">Selected total</span>
            <span className="text-lg font-semibold tabular-nums">{formatMoney(total, currency)}</span>
          </div>
          <Button
            variant="gold"
            className="w-full"
            disabled={picked.size === 0 || total <= 0 || submit.isPending}
            onClick={() => submit.mutate()}
          >
            Allocate
          </Button>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
