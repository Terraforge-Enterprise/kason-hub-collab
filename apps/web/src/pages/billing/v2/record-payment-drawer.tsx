// apps/web/src/pages/billing/v2/record-payment-drawer.tsx
// Payer-first atomic record+allocate (spec §4 / B3). One idempotencyKey per
// drawer-open (useRef) — a retry after failure REPLAYS instead of double-paying.
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PAYMENT_METHODS, PAYMENT_TYPES } from "@kason/shared";
import { apiFetch } from "@/lib/api-client";
import { recordAndAllocate } from "@/api/payments";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import { formatMoney } from "@/components/format";
import { usePayerOutstandingCharges } from "./use-billing-v2";

function defaultPaymentNumber(): string {
  return `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// Final-review fix wave: `new Date().toISOString()` is UTC wall-time, but a
// <input type="datetime-local"> displays/edits LOCAL wall-time — feeding it
// the ISO slice put the value 8h early in MYT (and can misfile the month at
// the day/month boundary). Build the local wall-time string field-by-field
// instead of going through any UTC conversion.
function localDateTimeValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isValidReceivedAt(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(new Date(value).getTime());
}

export function RecordPaymentDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const idemKeyRef = useRef<string>(crypto.randomUUID());
  const [paymentNumber, setPaymentNumber] = useState(defaultPaymentNumber);
  const [partyId, setPartyId] = useState("");
  const [method, setMethod] = useState("bank_transfer");
  const [type, setType] = useState("rental_payment");
  const [receivedAt, setReceivedAt] = useState(() => localDateTimeValue());
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map()); // chargeId -> "1500.00"

  const tenants = useQuery({
    queryKey: ["parties", "tenants"],
    queryFn: () => apiFetch<{ data: { id: string; displayName: string }[] }>("/parties/tenants"),
    enabled: open,
  });
  const pool = usePayerOutstandingCharges(open && partyId ? partyId : null);

  const total = useMemo(
    () => [...picked.values()].reduce((s, v) => s + (Number(v) || 0), 0),
    [picked],
  );

  function resetAfterClose() {
    idemKeyRef.current = crypto.randomUUID();
    setPicked(new Map());
    setPaymentNumber(defaultPaymentNumber());
  }

  function toggle(chargeId: string, outstanding: number) {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(chargeId)) next.delete(chargeId);
      else next.set(chargeId, outstanding.toFixed(2));
      return next;
    });
  }
  function setAmount(chargeId: string, raw: string, outstanding: number) {
    setPicked((prev) => new Map(prev).set(chargeId, raw));
    void outstanding;
  }
  function clampAmount(chargeId: string, outstanding: number) {
    setPicked((prev) => {
      const next = new Map(prev);
      const n = Number(next.get(chargeId));
      const clamped = !Number.isFinite(n) || n <= 0 ? 0.01 : Math.min(n, outstanding);
      next.set(chargeId, clamped.toFixed(2));
      return next;
    });
  }

  const submit = useMutation({
    mutationFn: () =>
      recordAndAllocate({
        paymentNumber,
        partyId,
        paymentType: type,
        paymentMethod: method,
        currency: "MYR",
        receivedAt: new Date(receivedAt).toISOString(),
        referenceNote: note || undefined,
        idempotencyKey: idemKeyRef.current,
        allocations: [...picked.entries()].map(([chargeId, allocatedAmount]) => ({
          chargeId,
          allocatedAmount: Number(allocatedAmount).toFixed(2),
        })),
      }),
    onSuccess: () => {
      toast.success(`Recorded ${formatMoney(total)} from the payer and allocated ${picked.size} charge(s)`);
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["billing"] });
      onOpenChange(false);
      resetAfterClose();
    },
    onError: (e: Error) => toast.error(e.message || "Recording failed — nothing was saved."),
  });

  const rows = pool.data?.data ?? [];

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetAfterClose(); }}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Record payment</SheetTitle>
          <SheetDescription>
            Pick the payer, tick the charges this money covers — recorded and allocated in one step.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <Field label="Payer">
            {tenants.isLoading ? (
              <div className="h-10 animate-pulse rounded-lg bg-[var(--card-bg)]" />
            ) : (
              // Only mounted once the tenants list has actually resolved — an
              // empty <select> that exists before the fetch settles would let
              // findByLabelText("Payer") resolve too early in tests (and let a
              // real user pick a payer before the option list is real).
              <SelectInput aria-label="Payer" value={partyId} onChange={(e) => { setPartyId(e.target.value); setPicked(new Map()); }}>
                <option value="">Select payer…</option>
                {(tenants.data?.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.displayName}</option>
                ))}
              </SelectInput>
            )}
          </Field>

          {partyId && (
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
                      onChange={(e) => setAmount(c.id, e.target.value, c.outstandingAmount)}
                      onBlur={() => clampAmount(c.id, c.outstandingAmount)}
                    />
                  )}
                </label>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Method">
              <SelectInput aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYMENT_METHODS.filter((m) => m !== "credit_note").map((m) => (
                  <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Type">
              <SelectInput aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                {PAYMENT_TYPES.filter((t) => t !== "credit_application").map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Received at">
              <TextInput type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </Field>
            <Field label="Payment number">
              <TextInput value={paymentNumber} onChange={(e) => setPaymentNumber(e.target.value)} />
            </Field>
          </div>
          <Field label="Reference note">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>

          <div className="flex items-center justify-between border-t border-[var(--card-border)] pt-3">
            <span className="text-sm text-[var(--text-secondary)]">Selected total</span>
            <span className="text-lg font-semibold tabular-nums">{formatMoney(total)}</span>
          </div>
          <Button
            variant="gold"
            className="w-full"
            disabled={
              picked.size === 0 ||
              !partyId ||
              total <= 0 ||
              submit.isPending ||
              !isValidReceivedAt(receivedAt)
            }
            onClick={() => submit.mutate()}
          >
            Record &amp; allocate
          </Button>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
