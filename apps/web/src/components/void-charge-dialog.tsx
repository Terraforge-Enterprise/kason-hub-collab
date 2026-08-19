/**
 * VoidChargeDialog — "Void & issue Credit Note" (spec §4.3).
 *
 * Unpaid posted charge: reason textarea only. Paid / partially-paid charge:
 * explicit three-way fork — recorded-in-error (revert the payment record first
 * via /billing/payments; submit disabled), hold-as-credit (CN credit balance,
 * auto-applies to next month), money-returned (Refund Note: amount / method /
 * bank ref / date / optional slip upload via /billing-documents/refund-proofs).
 *
 * Mounted from: /billing/charges void card (Task 11), unit workspace (Plan 4).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, API_BASE, ApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, TextAreaInput, TextInput } from "@/components/form-ui";

const PAID_STATUSES = ["paid", "partially_paid"];

type VoidBody = {
  reason: string;
  paidHandling?: "error_revert_first" | "hold_credit" | "refund";
  refund?: { amount: string; method: string; bankRef?: string; proofKey?: string; refundedAt: string };
};

// Friendly copy for the backend void error codes (spec §4.3 / credit-notes.service.ts).
// The route returns a bare code string as `{ error: "<CODE>" }`; apiFetch's
// extractApiError surfaces that verbatim as err.message with no `code` set
// (there's no top-level `code` field in the body), so we key off the raw
// error body/message here rather than ApiError.code. Anything unmapped falls
// back to the raw message so we never silently swallow a new backend code.
const VOID_ERROR_COPY: Record<string, string> = {
  REVERT_PAYMENT_FIRST:
    "This charge has a payment recorded against it. Revert the payment record first (Payments → set status), then void again.",
  CHARGE_NOT_POSTED: "This charge is no longer in a voidable state — refresh and check its current status.",
  CHARGE_NOT_FOUND: "That charge could not be found — refresh the page.",
  REFUND_DETAILS_REQUIRED: "Refund details are required when choosing “money returned”.",
  REFUND_AMOUNT_INVALID: "Enter a refund amount greater than zero.",
  REFUND_EXCEEDS_COLLECTED: "Refund amount exceeds the amount actually collected on this charge.",
  NO_PAYMENT_TO_REFUND: "No payment record was found to attribute this refund to.",
};

function voidErrorMessage(err: Error): string {
  const rawCode =
    err instanceof ApiError && err.data && typeof (err.data as Record<string, unknown>).error === "string"
      ? ((err.data as Record<string, unknown>).error as string)
      : err.message;
  return VOID_ERROR_COPY[rawCode] ?? err.message;
}

/**
 * Uploads the refund transfer-slip and returns the storage key to send as
 * refund.proofKey. Hits `fetch` directly (not `apiFetch`) because apiFetch
 * forces a JSON content-type — FormData needs the browser to set its own
 * multipart boundary. Mirrors uploadStatementReceipts (owner-billing.ts).
 */
async function uploadRefundProof(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/billing-documents/refund-proofs`, {
    method: "POST",
    body: fd,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // Pass `body` as the 4th (data) arg too — voidErrorMessage keys off
    // err.data.error for the backend's bare-code error shape, so without
    // this an upload failure loses its code mapping and always falls back
    // to the raw/generic message even when the backend returned a known code.
    throw new ApiError(body?.error || `Upload failed (${res.status})`, res.status, body?.code, body);
  }
  const body = (await res.json()) as { data: { key: string } };
  return body.data.key;
}

/**
 * Best-effort cleanup for a refund-proof object that was uploaded (via
 * uploadRefundProof, above) but never actually submitted with a void
 * request — e.g. the void call failed, or the admin cancelled/closed the
 * dialog before submitting. uploadRefundProof persists the file BEFORE the
 * void request goes out, so without this sweep-up every such path leaves an
 * orphan object in storage (project no-orphan-storage rule). Fire-and-forget
 * on purpose: a failure here is a storage-hygiene issue, not something the
 * admin needs to see a toast about — they already got (or will get) the
 * real success/error feedback for the void action itself.
 */
function deleteRefundProofBestEffort(key: string): void {
  apiFetch(`/billing-documents/refund-proofs`, {
    method: "DELETE",
    body: JSON.stringify({ key }),
  }).catch(() => {
    /* best-effort — swallow */
  });
}

export function VoidChargeDialog({
  charge,
  onClose,
  onDone,
}: {
  charge: { id: string; chargeNumber: string; status: string } | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [handling, setHandling] = useState<"error_revert_first" | "hold_credit" | "refund">("hold_credit");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("bank_transfer");
  const [refundBankRef, setRefundBankRef] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  // Tracks a refund-proof storage key that was uploaded but not yet (or no
  // longer) part of a submitted void request — see deleteRefundProofBestEffort.
  const uploadedKeyRef = useRef<string | null>(null);

  const isPaid = charge !== null && PAID_STATUSES.includes(charge.status);

  // Critical fix (review): this dialog is mounted ONCE by charges-forms.tsx
  // with no `key`, so switching the target charge previously left
  // reason/handling/refund* state from the PREVIOUS charge in place — an
  // admin could submit charge A's refund details against charge B. Reset
  // every field whenever the target charge changes (including to/from null,
  // i.e. close), and sweep up any dangling uploaded-but-unsubmitted proof
  // for the charge we're navigating away from (no-orphan-storage rule) —
  // defense-in-depth alongside the explicit close/cancel handler below, in
  // case the dialog ever transitions directly between two non-null charges
  // without going through handleClose first.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-charge-switch snapshot; same pattern as fee-config-drawer/TaskDrawer's reset-on-open (this dialog has no `key`, so a charge switch is the equivalent "reopen" moment).
    setReason("");
    setHandling("hold_credit");
    setRefundAmount("");
    setRefundMethod("bank_transfer");
    setRefundBankRef("");
    setRefundDate("");
    setProofFile(null);
    if (uploadedKeyRef.current) {
      deleteRefundProofBestEffort(uploadedKeyRef.current);
      uploadedKeyRef.current = null;
    }
    // Only re-run when the TARGET CHARGE changes — that's the one thing
    // this effect exists to react to. (deleteRefundProofBestEffort is a
    // stable module-level function and uploadedKeyRef is a ref, so neither
    // needs to be in the dependency array.)
  }, [charge?.id]);

  const voidMutation = useMutation({
    mutationFn: async () => {
      if (!charge) return;
      const body: VoidBody = { reason: reason.trim() };
      if (isPaid) {
        body.paidHandling = handling;
        if (handling === "refund") {
          let proofKey: string | undefined;
          if (proofFile) {
            proofKey = await uploadRefundProof(proofFile);
            uploadedKeyRef.current = proofKey;
          }
          body.refund = {
            amount: refundAmount,
            method: refundMethod,
            bankRef: refundBankRef || undefined,
            proofKey,
            refundedAt: refundDate,
          };
        }
      }
      return apiFetch<{ id: string; creditNoteNumber?: string | null; refundNoteNumber?: string | null }>(
        `/billing/charges/${charge.id}/void`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    onSuccess: (data) => {
      // The key is now referenced by the persisted refund note — no longer
      // an orphan candidate.
      uploadedKeyRef.current = null;
      const cn = data && "creditNoteNumber" in data ? data.creditNoteNumber : null;
      toast.success(cn ? `Voided — Credit Note ${cn} issued.` : "Charge voided.");
      qc.invalidateQueries({ queryKey: ["billing"] });
      onDone?.();
      onClose();
    },
    onError: (err: Error) => {
      // The void request failed (or the upload step inside it did) — any
      // proof we already uploaded is now an orphan. Best-effort cleanup;
      // never blocks or overrides the user-facing error toast below.
      if (uploadedKeyRef.current) {
        deleteRefundProofBestEffort(uploadedKeyRef.current);
        uploadedKeyRef.current = null;
      }
      toast.error(voidErrorMessage(err));
    },
  });

  // Cancel / close (X button, Escape, backdrop click) with an
  // uploaded-but-unsubmitted proof still pending — clean it up before
  // notifying the parent.
  function handleClose() {
    if (voidMutation.isPending) return;
    if (uploadedKeyRef.current) {
      deleteRefundProofBestEffort(uploadedKeyRef.current);
      uploadedKeyRef.current = null;
    }
    onClose();
  }

  const refundIncomplete =
    handling === "refund" && (!refundAmount || !refundMethod || !refundDate);
  const disabled =
    reason.trim().length < 3 ||
    voidMutation.isPending ||
    (isPaid && handling === "error_revert_first") ||
    (isPaid && refundIncomplete);

  return (
    <Dialog open={charge !== null} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void &amp; issue Credit Note</DialogTitle>
          <DialogDescription>
            {charge ? `${charge.chargeNumber} — a Credit Note referencing the original document will be issued. This cannot be undone.` : ""}
          </DialogDescription>
        </DialogHeader>

        {isPaid && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Was this payment recorded in error, or is this a genuine reversal?
            </legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="paid-handling"
                aria-label="Recorded in error"
                checked={handling === "error_revert_first"}
                onChange={() => setHandling("error_revert_first")}
              />
              <span>
                Recorded in error (mark-paid mistake, no real money)
                {handling === "error_revert_first" && (
                  <span className="block text-xs text-muted-foreground">
                    Revert the payment record first on the Payments page, then void this charge.
                  </span>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="paid-handling"
                aria-label="Hold as credit"
                checked={handling === "hold_credit"}
                onChange={() => setHandling("hold_credit")}
              />
              <span>
                Genuine — hold as credit
                <span className="block text-xs text-muted-foreground">
                  The collected amount becomes CN credit and auto-applies to the tenancy&apos;s next charges.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="paid-handling"
                aria-label="Money returned"
                checked={handling === "refund"}
                onChange={() => setHandling("refund")}
              />
              <span>
                Genuine — money returned
                <span className="block text-xs text-muted-foreground">
                  A Refund Note is issued with the transfer details.
                </span>
              </span>
            </label>
          </fieldset>
        )}

        {isPaid && handling === "refund" && (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Refund amount">
              <TextInput
                aria-label="Refund amount"
                type="number"
                min={0}
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </Field>
            <Field label="Refund method">
              <TextInput
                aria-label="Refund method"
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value)}
              />
            </Field>
            <Field label="Bank reference">
              <TextInput
                aria-label="Bank reference"
                value={refundBankRef}
                onChange={(e) => setRefundBankRef(e.target.value)}
              />
            </Field>
            <Field label="Refunded on">
              <TextInput
                aria-label="Refunded on"
                type="date"
                value={refundDate}
                onChange={(e) => setRefundDate(e.target.value)}
              />
            </Field>
            <Field label="Transfer slip (optional)">
              <input
                aria-label="Transfer slip"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
            </Field>
          </div>
        )}

        <Field label="Reason">
          <TextAreaInput
            aria-label="Reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this charge being voided? (required)"
          />
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={voidMutation.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={disabled} onClick={() => voidMutation.mutate()}>
            {voidMutation.isPending ? "Voiding…" : "Void & issue Credit Note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
