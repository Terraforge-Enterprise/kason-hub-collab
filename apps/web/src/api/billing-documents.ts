// Typed react-query hooks for the accounting Documents register.
// Server-side flag-gated by ENABLE_PHASE2_BILLING_DOCS (404 while dark).
// Money travels as 2-dp decimal STRINGS.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  BillingDocumentDetail,
  BillingDocumentListItem,
  ChargeAdjustmentInput,
  CreateCreditNoteInput,
  VoidChargeAdjustmentInput,
} from "@kason/shared";
import { apiFetch } from "@/lib/api-client";

export type BillingDocumentFilters = {
  docType?: string;
  /** Multi-docType filter — serialized to a CSV `docTypes` param. Lets a register span
   * several docTypes at once (Invoices = invoice + debit_note). Supersedes `docType`. */
  docTypes?: string[];
  /** Register opt-in: only PRIMARY docs (excludes correction/adjustment notes). */
  primaryOnly?: boolean;
  /** Register opt-in: exclude CANCELLED / SUPERSEDED docs (live bills only). */
  activeOnly?: boolean;
  seriesId?: string;
  partyId?: string;
  apartmentId?: string;
  /** "YYYY-MM". */
  month?: string;
  status?: string;
  /** "tenant" | "owner" — the Tenant/Owner tab. */
  counterpartyType?: string;
  propertyId?: string;
  /** Issued-date range, inclusive — "YYYY-MM-DD". */
  dateFrom?: string;
  dateTo?: string;
  /** Matches document #, party name, or party phone. */
  q?: string;
  page?: number;
  pageSize?: number;
};

function toQueryString(f: BillingDocumentFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(","));
      continue;
    }
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Pass `undefined` to keep the query DISABLED (no fetch) — Plan 4's unit
 * workspace calls this with `undefined` while ENABLE_PHASE2_BILLING_DOCS is
 * dark. The documents register page always passes defined filters.
 */
export function useBillingDocuments(filters: BillingDocumentFilters | undefined) {
  return useQuery({
    queryKey: ["billing-documents", filters],
    queryFn: () =>
      apiFetch<{ data: { items: BillingDocumentListItem[]; total: number } }>(
        `/billing-documents${toQueryString(filters ?? {})}`,
      ),
    enabled: filters !== undefined,
  });
}

export type PropertyOption = { id: string; name: string };

/** Lightweight property list (id + name) for the accounting filter dropdowns.
 * Reuses the admin inventory list; cached since it rarely changes within a session. */
export function usePropertyOptions() {
  return useQuery({
    queryKey: ["inventory", "property-options"],
    queryFn: async () => {
      const res = await apiFetch<{ data: Array<{ id: string; name: string }> }>("/inventory/properties");
      return res.data.map((p) => ({ id: p.id, name: p.name }) satisfies PropertyOption);
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useBillingDocument(id: string | null) {
  return useQuery({
    queryKey: ["billing-documents", "detail", id],
    queryFn: () => apiFetch<{ data: BillingDocumentDetail }>(`/billing-documents/${id}`),
    enabled: id !== null,
  });
}

/** Signed PDF URL — renders on demand server-side. Open in a new tab. */
export async function fetchBillingDocumentPdfUrl(id: string): Promise<string> {
  const res = await apiFetch<{ data: { url: string } }>(`/billing-documents/${id}/pdf`);
  return res.data.url;
}

/** Signed URL for a line-item attachment (bill-expenses R6). Open in a new tab. */
export async function fetchBillingDocumentAttachmentUrl(docId: string, attachmentId: string): Promise<string> {
  const res = await apiFetch<{ data: { url: string } }>(`/billing-documents/${docId}/attachments/${attachmentId}/url`);
  return res.data.url;
}

/** P4 (R12): manual overpayment Credit Note create. */
export function useCreateCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCreditNoteInput) =>
      apiFetch<{ data: { id: string; documentNumber: string; creditAmount: string } }>(
        "/billing-documents/credit-notes",
        { method: "POST", body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-documents"] }),
  });
}

export type CreateChargeAdjustmentResult = {
  id: string;
  documentNumber: string;
  docType: "debit_note" | "credit_note";
  creditAmount?: string;
};

/**
 * Invoice-adjustments Phase 3.2 — charge-scoped CREATE credit/debit note
 * (POST /billing-documents/charge-adjustments), tenant-only, flag-gated
 * server-side (§7-A4). The server re-derives everything authoritatively
 * (cap check, sign, linked invoice); this hook is presentational plumbing
 * only, mirroring useCreateCreditNote's shape.
 */
export function useCreateChargeAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChargeAdjustmentInput) =>
      apiFetch<{ data: CreateChargeAdjustmentResult }>("/billing-documents/charge-adjustments", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-documents"] }),
  });
}

/**
 * Invoice-adjustments Phase 4.2 — VOID a charge-scoped credit/debit note
 * (POST /billing-documents/:id/void). `id` is the note's BillingDocument id
 * (a route param server-side, not a body field) — mirrors the route's own
 * shape (voidChargeAdjustmentInput carries only reason/idempotencyKey).
 */
export function useVoidChargeAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: VoidChargeAdjustmentInput & { id: string }) =>
      apiFetch<{ data: { id: string; documentStatus: "CANCELLED" } }>(`/billing-documents/${v.id}/void`, {
        method: "POST",
        body: JSON.stringify({
          reason: v.reason,
          ...(v.idempotencyKey ? { idempotencyKey: v.idempotencyKey } : {}),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["billing-documents"] }),
  });
}
