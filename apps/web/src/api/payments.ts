import { apiFetch } from "@/lib/api-client";

export function allocateBatch(
  paymentId: string,
  idempotencyKey: string,
  allocations: { chargeId: string; allocatedAmount: string; prorateRatio?: string }[],
) {
  return apiFetch(`/payments/${paymentId}/allocate-batch`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey, allocations }),
  });
}

export function postPayment(paymentId: string) {
  return apiFetch(`/payments/${paymentId}/post`, { method: "POST" });
}

/** Refuse a tenant-submitted transfer slip. `reason` is shown verbatim to the tenant. */
export function rejectPayment(paymentId: string, reason: string) {
  return apiFetch(`/payments/${paymentId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/**
 * One uploaded transfer slip, signed and classified server-side.
 *
 * `url` carries a download disposition on purpose — the viewer fetches it and
 * re-stamps the bytes with `mimeType` rather than navigating to it. See
 * pages/accounting/slip-viewer.tsx for why that distinction is load-bearing.
 */
export type PendingPaymentSlip = {
  url: string;
  /** "other" → the file isn't a format we can preview; offer the download only. */
  kind: "image" | "pdf" | "other";
  mimeType: string | null;
  filename: string;
};

/** Tenant-submitted payments awaiting verification against one billing document. */
export type PendingVerificationPayment = {
  id: string;
  paymentNumber: string;
  payerName: string;
  /** The whole transfer as the tenant reports it — the figure on the slip. */
  amount: string;
  /** The share of that transfer landing on THIS document's charges. */
  allocatedToThisDocument: string;
  spansOtherDocuments: boolean;
  paymentMethod: string;
  bankReference: string | null;
  note: string | null;
  submittedAt: string;
  slips: PendingPaymentSlip[];
  slipUnavailable: boolean;
  lines: { chargeId: string; description: string; allocatedAmount: string }[];
};

export function fetchPendingPayments(documentId: string) {
  return apiFetch<{ data: PendingVerificationPayment[] }>(`/billing-documents/${documentId}/pending-payments`);
}

export function reverseAllocation(paymentId: string, allocationId: string) {
  return apiFetch(`/payments/${paymentId}/allocations/${allocationId}/reverse`, {
    method: "POST",
  });
}

export const ENABLE_MULTI_PAY =
  import.meta.env.VITE_ENABLE_PHASE2_MULTI_PAY === "true" ||
  import.meta.env.VITE_ENABLE_PHASE2_MULTI_PAY === "1";

export const ENABLE_FPX =
  import.meta.env.VITE_ENABLE_PHASE2_FPX === "true" ||
  import.meta.env.VITE_ENABLE_PHASE2_FPX === "1";

// ── In-flight FPX ops (admin) ────────────────────────────────────────────────

export type InFlightFpxItem = {
  id: string;
  paymentNumber: string;
  partyName: string;
  amount: number;
  currency: string;
  createdAt: string;
  ageMinutes: number;
};

export function listInFlightFpx() {
  return apiFetch<{ data: InFlightFpxItem[] }>("/payments/fpx/in-flight");
}

export function cancelInFlightFpx(paymentId: string) {
  return apiFetch(`/payments/fpx/${paymentId}/cancel`, { method: "POST" });
}

// ── Needs-reconciliation queue (admin) ───────────────────────────────────────
// Payments the bank CONFIRMED that we could not apply automatically, because a
// person had already cancelled them (or the gateway had already failed them).
// Every row is money the payer has most likely been debited for and our books do
// not yet show — a liability with a 60-day clock, not a report.

export type NeedsReconciliationItem = {
  id: string;
  paymentNumber: string;
  partyName: string;
  amount: number;
  currency: string;
  createdAt: string;
  ageHours: number;
  /** Who closed the payment before the bank confirmed it. */
  closedBy: "admin" | "gateway";
  providerTranId: string | null;
};

export function listNeedsReconciliation() {
  return apiFetch<{ data: NeedsReconciliationItem[] }>("/payments/fpx/needs-reconciliation");
}

export function resolveNeedsReconciliation(
  paymentId: string,
  body: { action: "settle" | "dismiss"; reason: string },
) {
  return apiFetch(`/payments/fpx/${paymentId}/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function recordAndAllocate(body: {
  paymentNumber: string; partyId: string; paymentType: string; paymentMethod: string;
  currency: string; receivedAt: string; referenceNote?: string; externalReference?: string;
  idempotencyKey: string; allocations: { chargeId: string; allocatedAmount: string }[];
}) {
  return apiFetch(`/payments/record-and-allocate`, { method: "POST", body: JSON.stringify(body) });
}
export function getPaymentsSummary(month: string) {
  return apiFetch<{ receivedTotal: number; unallocatedCount: number; pendingApprovalCount: number; inFlightFpxCount: number }>(
    `/payments/summary?month=${month}`,
  );
}
