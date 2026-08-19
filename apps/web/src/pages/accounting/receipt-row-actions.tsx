// ReceiptRowActions — R9 (Task 12) per-row correction actions on the Receipts
// register. Three actions, each a confirm dialog naming its effect:
//   • Reverse       → useReverseAllocation (POST …/allocations/:id/reverse)
//   • Void payment  → useVoidPayment (PUT …/status {status:"void"}) — VOID ONLY
//   • Refund        → the REFUND correction strategy (CorrectInvoiceDrawer)
//
// The server is authoritative for bounds / idempotency / authz. A 409 (an
// in-flight FPX attempt, or a StaleError from a concurrent update) is rendered
// INLINE inside the dialog — never a silent toast — and the dialog stays open.
//
// Data-resolution limitation (documented, not faked): "Void payment" needs the
// receipt's paymentId, now exposed on the list DTO (Task 12). "Reverse" needs a
// specific PaymentAllocation id, which NO read DTO surfaces today — a receipt's
// payment can carry several allocations and there is no endpoint returning their
// ids. So the accountant supplies/confirms the allocation id in the dialog; the
// server validates it (404 on a bad/cross-org id). This mirrors the multi-charge
// note in Task 11 — the plumbing is real and server-checked; only the automatic
// id resolution is out of this task's scope.
import { useState } from "react";
import type { BillingDocumentListItem } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Field, TextInput, TextAreaInput } from "@/components/form-ui";
import { useReverseAllocation, useVoidPayment } from "@/api/accounting";

type Dialog = null | "reverse" | "void";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function ReceiptRowActions({
  doc,
  onRefund,
}: {
  doc: BillingDocumentListItem;
  onRefund: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [allocationId, setAllocationId] = useState("");
  const [reason, setReason] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);

  const reverse = useReverseAllocation();
  const voidPayment = useVoidPayment();

  const paymentId = doc.paymentId ?? null;

  function close() {
    setDialog(null);
    setAllocationId("");
    setReason("");
    setInlineError(null);
  }

  function submitReverse() {
    if (!paymentId) return;
    setInlineError(null);
    reverse.mutate(
      {
        paymentId,
        allocationId: allocationId.trim(),
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => close(),
        onError: (err) => setInlineError(errorMessage(err)),
      },
    );
  }

  function submitVoid() {
    if (!paymentId) return;
    setInlineError(null);
    // VOID ONLY — status:"void" is fixed inside useVoidPayment; never "refunded".
    voidPayment.mutate(
      { paymentId, note: reason.trim() || undefined },
      {
        onSuccess: () => close(),
        onError: (err) => setInlineError(errorMessage(err)),
      },
    );
  }

  const reverseDisabled =
    !paymentId || allocationId.trim().length < 8 || reason.trim().length < 3 || reverse.isPending;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button variant="outline" size="sm" onClick={() => setDialog("reverse")}>
        Reverse
      </Button>
      <Button variant="outline" size="sm" onClick={() => setDialog("void")}>
        Void payment
      </Button>
      {/* Void ≠ Refund: "Refund" opens the REFUND correction strategy (a Refund
          Note), NOT a raw payment-status change. */}
      <Button variant="outline" size="sm" onClick={onRefund}>
        Refund
      </Button>

      {dialog === "void" && (
        <div
          role="dialog"
          aria-label="Void this payment"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl">
            <div>
              <h2 className="text-base font-semibold">Void the payment for {doc.documentNumber}?</h2>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Sets the payment to <strong>void</strong> and reverses every applied allocation,
                restoring the charges' outstanding amounts. This is not a refund — to return money
                to the tenant, use <em>Refund</em> instead.
              </p>
            </div>
            <Field label="Reason">
              <TextAreaInput
                aria-label="Reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {!paymentId && (
              <p className="text-xs text-rose-600">
                This receipt isn't linked to a payment, so it can't be voided here.
              </p>
            )}
            {inlineError && (
              <p role="alert" className="text-sm text-rose-600">
                {inlineError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!paymentId || voidPayment.isPending}
                onClick={submitVoid}
              >
                Confirm void
              </Button>
            </div>
          </div>
        </div>
      )}

      {dialog === "reverse" && (
        <div
          role="dialog"
          aria-label="Reverse an allocation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md space-y-4 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-5 shadow-xl">
            <div>
              <h2 className="text-base font-semibold">Reverse an allocation on {doc.documentNumber}?</h2>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Writes an append-only reversal against one PaymentAllocation and restores that
                charge's outstanding amount. The original allocation is never deleted.
              </p>
            </div>
            <Field label="Allocation ID">
              <TextInput
                aria-label="Allocation ID"
                placeholder="PaymentAllocation UUID"
                value={allocationId}
                onChange={(e) => setAllocationId(e.target.value)}
              />
            </Field>
            <p className="text-xs text-[var(--text-secondary)]">
              The receipt doesn't yet surface its allocation ids automatically — paste the
              allocation to reverse. The server validates it.
            </p>
            <Field label="Reason">
              <TextAreaInput
                aria-label="Reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            {inlineError && (
              <p role="alert" className="text-sm text-rose-600">
                {inlineError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={reverseDisabled}
                onClick={submitReverse}
              >
                Confirm reverse
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
