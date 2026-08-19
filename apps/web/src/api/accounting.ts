import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CorrectionStrategy, ManualInvoiceInput, RecordAndAllocateInput, RecordInvoicePaymentInput, RefundDetailsInput } from "@kason/shared";
import { apiFetch, API_BASE, ApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";

export function useCreateManualInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ManualInvoiceInput) =>
      apiFetch<{ data: { documents: { id: string; documentNumber: string }[]; chargeIds: string[] } }>(
        "/billing-documents/invoices",
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
    },
  });
}

/** R9 replacement-line shape for the CANCEL_AND_REPLACE strategy. */
export type CorrectionReplacementLine = { categoryId: string; description: string; amount: string };

/** Body posted by the Correct-invoice drawer (R9). The server re-derives the
 * effect authoritatively from `strategy`; refund/replacement/adjustmentAmount are
 * only meaningful for their respective strategy. */
export type CorrectInvoiceInput = {
  chargeId: string;
  strategy: CorrectionStrategy;
  reason: string;
  refund?: RefundDetailsInput;
  replacement?: { lines: CorrectionReplacementLine[] };
  adjustmentAmount?: string;
};

export type CorrectInvoiceResult = {
  creditNoteNumber?: string | null;
  debitNoteNumber?: string | null;
  replacementNumber?: string | null;
  refundNoteNumber?: string | null;
};

/**
 * Correct a posted invoice via the R9 strategy drawer. Posts to the same
 * void-correction route the VoidChargeDialog uses; the server re-derives the
 * effect from `strategy` (CREDIT/DEBIT/CANCEL_AND_REPLACE/REFUND) — the drawer is
 * presentational. Only the fields the chosen strategy needs are sent.
 */
export function useCorrectInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: CorrectInvoiceInput) =>
      apiFetch<CorrectInvoiceResult>(`/billing/charges/${v.chargeId}/void`, {
        method: "POST",
        body: JSON.stringify({
          strategy: v.strategy,
          reason: v.reason,
          ...(v.refund ? { refund: v.refund } : {}),
          ...(v.replacement ? { replacement: v.replacement } : {}),
          ...(v.adjustmentAmount ? { adjustmentAmount: v.adjustmentAmount } : {}),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
      void qc.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

/**
 * R9 (Task 12) — reverse a single PaymentAllocation on a receipt's payment.
 * POST /payments/:paymentId/allocations/:allocationId/reverse.
 *
 * The component supplies a fresh `crypto.randomUUID()` idempotencyKey per
 * invocation (the server's reversal is idempotent on it — Task 4). `amount` is
 * optional (absent = the full allocated amount). The server is authoritative
 * for bounds/idempotency/authz; a 409 (in-flight FPX or a StaleError race)
 * surfaces to the caller's onError so the row can render it inline.
 */
export function useReverseAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      paymentId: string;
      allocationId: string;
      reason: string;
      idempotencyKey: string;
      amount?: string;
    }) =>
      apiFetch<{ reversalId: string; effectiveAllocated: number }>(
        `/payments/${v.paymentId}/allocations/${v.allocationId}/reverse`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: v.reason,
            idempotencyKey: v.idempotencyKey,
            ...(v.amount ? { amount: v.amount } : {}),
          }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
    },
  });
}

/**
 * R9 (Task 12) — VOID a receipt's payment. PUT /payments/:paymentId/status with
 * `status:"void"`. VOID ONLY: per the user's Void≠Refund decision, a genuine
 * outgoing refund goes through the REFUND correction strategy (CorrectInvoiceDrawer),
 * NOT a raw `status:"refunded"` here. Voiding reverses every applied allocation
 * server-side (append-only, R5). The server enforces authz + the in-flight-FPX
 * guard (409); onError surfaces it for an inline render.
 */
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { paymentId: string; note?: string }) =>
      apiFetch<{ id: string }>(`/payments/${v.paymentId}/status`, {
        method: "PUT",
        body: JSON.stringify({ status: "void", note: v.note }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
    },
  });
}

export function useRecordTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordAndAllocateInput) =>
      apiFetch<{ id: string }>("/payments/record-and-allocate", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
    },
  });
}

/** Invoice-scoped "Record payment" — payer + method are derived server-side from the
 * document; the payment amount is Σ(allocations) and a transfer slip is mandatory. */
export function useRecordInvoicePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordInvoicePaymentInput) =>
      apiFetch<{ id: string }>("/payments/record-invoice-payment", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["billing-documents"] });
    },
  });
}

/**
 * Upload a slip; server mints + returns the storage key. Hits `fetch` directly
 * (not `apiFetch`) because apiFetch forces a JSON content-type — FormData needs
 * the browser to set its own multipart boundary. MIRRORS the proven
 * uploadRefundProof in apps/web/src/components/void-charge-dialog.tsx:67-87
 * (same endpoint, same API_BASE + getAdminToken + credentials:"include").
 */
export async function uploadSlipProof(file: File): Promise<string> {
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
    throw new ApiError(body?.error || `Upload failed (${res.status})`, res.status, body?.code, body);
  }
  const body = (await res.json()) as { data: { key: string } };
  return body.data.key;
}

/**
 * Best-effort orphan cleanup when the record call fails after upload. Goes
 * through apiFetch (JSON DELETE) — mirrors deleteRefundProofBestEffort in
 * void-charge-dialog.tsx:100-107.
 */
export async function deleteSlipProof(key: string): Promise<void> {
  await apiFetch("/billing-documents/refund-proofs", { method: "DELETE", body: JSON.stringify({ key }) });
}
