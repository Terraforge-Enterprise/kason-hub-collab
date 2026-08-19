// The admin's verification surface for tenant-submitted bank transfers.
//
// A tenant who paid outside FPX (cheque, bank-app transfer) uploads a slip and
// picks the lines it covers. Nothing settles until an admin looks at the slip
// and agrees — this panel is that decision, sited in the invoice drawer because
// that is where the register's red dot leads.
//
// Approve reuses the existing POST /payments/:id/post; Reject is the new
// counterpart and always carries a reason, which the tenant reads verbatim.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";
import {
  fetchPendingPayments,
  postPayment,
  rejectPayment,
  type PendingVerificationPayment,
} from "@/api/payments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { formatDateTimeMY, formatMoney, toTitleCase } from "@/components/format";
import { SlipViewer } from "./slip-viewer";

/** react-query key so the drawer and the register invalidate the same data. */
export function pendingPaymentsKey(documentId: string) {
  return ["billing-document-pending-payments", documentId] as const;
}

function LineRow({ line }: { line: PendingVerificationPayment["lines"][number] }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-xs text-muted-foreground">{line.description}</span>
      <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
        {formatMoney(Number(line.allocatedAmount))}
      </span>
    </div>
  );
}

function Slips({ payment }: { payment: PendingVerificationPayment }) {
  if (payment.slipUnavailable) {
    return (
      <Callout variant="warning" title="Slip unavailable">
        The transfer slip is attached but could not be opened just now. Refresh to try again — don't
        approve on the reference number alone.
      </Callout>
    );
  }
  if (payment.slips.length === 0) {
    // Submitting without a slip is blocked server-side (portalPaySchema), so
    // this is either a legacy row or a contract regression — say so plainly
    // rather than rendering a blank space the admin might read as "no proof needed".
    return (
      <Callout variant="warning" title="No slip attached">
        This payment was submitted without proof of transfer. Verify it against the bank statement
        before approving.
      </Callout>
    );
  }
  return <SlipViewer slips={payment.slips} />;
}

function PendingPaymentCard({
  payment,
  onSettled,
}: {
  payment: PendingVerificationPayment;
  onSettled: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);

  const approve = useMutation({
    mutationFn: () => postPayment(payment.id),
    onSuccess: () => {
      toast.success(`Approved ${payment.paymentNumber} — ${formatMoney(Number(payment.amount))} applied.`);
      onSettled();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not approve this payment."),
  });

  const reject = useMutation({
    mutationFn: () => rejectPayment(payment.id, reason.trim()),
    onSuccess: () => {
      toast.success(`Rejected ${payment.paymentNumber}. The tenant can see why and re-submit.`);
      setReason("");
      onSettled();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not reject this payment."),
  });

  const busy = approve.isPending || reject.isPending;
  // Mirrors rejectPaymentSchema's min(3) — a rejection with no usable reason
  // leaves the tenant able only to re-send the same slip.
  const reasonTooShort = reason.trim().length < 3;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{payment.payerName}</span>
            <Badge variant="amber">Awaiting verification</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {payment.paymentNumber} · {toTitleCase(payment.paymentMethod.replace(/_/g, " "))} ·
            submitted {formatDateTimeMY(payment.submittedAt)}
          </p>
          {payment.bankReference ? (
            <p className="text-xs text-muted-foreground">
              Bank reference: <span className="font-medium text-foreground">{payment.bankReference}</span>
            </p>
          ) : null}
          {payment.note ? <p className="text-xs italic text-muted-foreground">“{payment.note}”</p> : null}
        </div>
        {/* Two figures when a transfer spans invoices: the slip's own total
            (what the admin matches against the bank statement) and the share
            landing here (what foots to the lines below). One number could not
            be right for both jobs. */}
        <div className="shrink-0 text-right">
          <p className="text-xs text-muted-foreground">
            {payment.spansOtherDocuments ? "On this invoice" : "Claimed"}
          </p>
          <p className="text-xl font-bold tabular-nums text-foreground">
            {formatMoney(Number(payment.allocatedToThisDocument))}
          </p>
          {payment.spansOtherDocuments ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              of {formatMoney(Number(payment.amount))} transferred
            </p>
          ) : null}
        </div>
      </div>

      <Slips payment={payment} />

      <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
        <p className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          Lines this payment covers on this invoice
        </p>
        {payment.lines.map((l) => (
          <LineRow key={l.chargeId} line={l} />
        ))}
      </div>

      <div className="space-y-2">
        <label htmlFor={`reject-reason-${payment.id}`} className="block text-xs text-muted-foreground">
          Reason (required to reject — the tenant reads this)
        </label>
        <input
          id={`reject-reason-${payment.id}`}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Slip is unreadable, or the amount doesn't match"
          className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || reasonTooShort}
          onClick={() => setConfirming("reject")}
          className="text-rose-600"
        >
          {reject.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Reject
        </Button>
        <Button type="button" variant="gold" disabled={busy} onClick={() => setConfirming("approve")}>
          {approve.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Approve payment
        </Button>
      </div>

      {/* Both directions confirm: approving records money as received, and
          rejecting tells a tenant their payment wasn't accepted. Neither is
          something to fire from a stray click. */}
      <ConfirmAlert
        open={confirming === "approve"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          approve.mutate();
        }}
        title="Approve this payment?"
        confirmLabel="Approve payment"
        destructive
        body={
          <>
            This records <strong>{formatMoney(Number(payment.amount))}</strong> from{" "}
            <strong>{payment.payerName}</strong> as received.{" "}
            {payment.spansOtherDocuments ? (
              <>
                It settles the {payment.lines.length} line
                {payment.lines.length === 1 ? "" : "s"} above{" "}
                <strong>and further charges on other invoices</strong> that this same transfer
                covers — approving here settles all of them, not just this invoice.
              </>
            ) : (
              <>
                It settles the {payment.lines.length} line
                {payment.lines.length === 1 ? "" : "s"} above.
              </>
            )}{" "}
            Only do this once you've checked the slip against the bank account.
          </>
        }
      />
      <ConfirmAlert
        open={confirming === "reject"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          setConfirming(null);
          reject.mutate();
        }}
        title="Reject this payment?"
        confirmLabel="Reject payment"
        destructive
        body={
          <>
            <strong>{payment.payerName}</strong> will see this reason and can submit again:
            <span className="mt-2 block rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm">
              {reason.trim()}
            </span>
          </>
        }
      />
    </div>
  );
}

/**
 * Renders nothing at all when there is nothing pending — this panel is an
 * exception queue, and an "All clear" box on every invoice would be noise.
 */
export function PendingVerificationPanel({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: pendingPaymentsKey(documentId),
    queryFn: () => fetchPendingPayments(documentId),
    enabled: !!documentId,
  });

  function invalidateAll() {
    // The document detail (amountPaid/balance), this panel, and the register's
    // red-dot count all move together on approve/reject.
    void queryClient.invalidateQueries({ queryKey: pendingPaymentsKey(documentId) });
    void queryClient.invalidateQueries({ queryKey: ["billing-document", documentId] });
    void queryClient.invalidateQueries({ queryKey: ["billing-documents"] });
  }

  if (isLoading) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted" />;
  }
  if (error) {
    return (
      <Callout variant="danger" title="Couldn't load pending payments">
        Refresh the drawer — if a tenant has submitted a transfer slip, it won't appear until this
        loads.
      </Callout>
    );
  }

  const pending = data?.data ?? [];
  if (pending.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-5 w-5 text-amber-600" />
        <h3 className="text-sm font-semibold text-foreground">
          Awaiting your verification ({pending.length})
        </h3>
      </div>
      <Callout variant="warning">
        The tenant says they've paid and uploaded proof. Nothing is applied to this invoice until you
        approve — the balance below still shows the full amount on purpose.
      </Callout>
      {pending.map((p) => (
        <PendingPaymentCard key={p.id} payment={p} onSettled={invalidateAll} />
      ))}
    </div>
  );
}
