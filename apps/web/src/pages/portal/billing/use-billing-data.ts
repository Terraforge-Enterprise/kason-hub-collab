import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import type { PortalDashboardResponse } from "@kason/shared";

// Shared query hooks + shapes for the Billing shell (T5) and its tabs
// (T6 Invoices & Charges, T7 Payments). Query keys are the cache-sharing
// contract across those tasks — changing a key changes cache identity for
// every consumer, including the Home dashboard (`useDashboard`).

export type ChargeItem = {
  id: string;
  /** Internal key — NEVER render this to a tenant. For grid-minted charges it
   * embeds raw UUIDs. Use `documentNumber`. */
  chargeNumber: string;
  /** The number on the bill the tenant was sent (IVTEN-0002, DEP-2026-0007), or
   * null when the charge is on no bill yet. Resolved server-side from the charge's
   * BillingDocument — see tenant-charge-reference.ts. Optional so an older API
   * still parses. */
  documentNumber?: string | null;
  chargeType: string;
  description: string | null;
  status: string;
  dueDate: string;
  amount: number;
  /** CN/DN awareness (2026-08-06) — optional so an older API still parses. */
  debitNoteTotal?: number;
  creditNoteTotal?: number;
  /** amount + debit notes − credit notes; what the Total column should show. */
  adjustedAmount?: number;
  outstandingAmount: number;
  currency: string;
};

export type PaymentItem = {
  id: string;
  paymentNumber: string;
  paymentMethod: string;
  status: string;
  amount: number;
  currency: string;
  receivedAt: string;
  referenceNote: string | null;
  /** Why the office refused this transfer slip. Set only when status === "rejected". */
  rejectionReason?: string | null;
};

export type PaginatedResponse<T> = {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

/** Dashboard summary (balance + upcoming/recent snapshots) — queryKey shared with Home. */
export function useDashboard() {
  return useQuery({
    queryKey: ["portal-dashboard"],
    queryFn: () => portalApiFetch<{ data: PortalDashboardResponse }>("/dashboard"),
  });
}

export function usePortalCharges(page: number) {
  return useQuery({
    queryKey: ["portal-charges", page],
    queryFn: () => portalApiFetch<PaginatedResponse<ChargeItem>>(`/charges?page=${page}&limit=20`),
  });
}

export function usePortalPayments(page: number) {
  return useQuery({
    queryKey: ["portal-payments", page],
    queryFn: () => portalApiFetch<PaginatedResponse<PaymentItem>>(`/payments?page=${page}&limit=20`),
  });
}

/**
 * Past-due, still-unpaid charge — the simplified "overdue" rule used by the
 * Billing header (spec R8). `/dashboard`'s `upcomingCharges` is truncated and
 * carries no paid/overdue distinction, so the header sums this predicate over
 * the fuller `/charges` list (`usePortalCharges`) instead. Only
 * `status === "posted"` counts as unpaid-and-due; this v1 rule intentionally
 * excludes partial/partially_paid (see task-5 brief "Risk & rollback").
 */
export function isOverdueCharge(charge: ChargeItem, today: Date = new Date()): boolean {
  if (charge.status !== "posted") return false;
  const cutoff = new Date(today);
  cutoff.setHours(0, 0, 0, 0);
  return new Date(charge.dueDate) < cutoff;
}
