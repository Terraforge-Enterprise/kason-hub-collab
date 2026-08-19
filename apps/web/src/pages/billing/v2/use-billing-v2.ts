// apps/web/src/pages/billing/v2/use-billing-v2.ts
// Hooks + types for the charges/payments v2 pages (2026-07-04 spec).
// Month params are BARE "YYYY-MM" (documents API strict-regex gotcha).
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { ChargeListItem } from "../charges-table";

export type ChargeListItemV2 = ChargeListItem & {
  displayStatus: string;
  documentId: string | null;
};

export type GroupedChargeRow = {
  id: string; chargeNumber: string; partyName: string; tenancyCode: string | null;
  chargeType: string; categoryLabel: string; status: string; displayStatus: string;
  dueDate: string; amount: number; outstandingAmount: number; currency: string;
  documentId: string | null; documentNumber: string | null;
  track: "tenant_fees" | "pass_through" | "owner";
};

export type ChargeGroup = {
  key: string;
  kind: "unit" | "carpark" | "unassigned" | "statement" | "unattached";
  label: string; propertyName: string; apartmentId: string | null; subtitle: string;
  statementStatus: string | null;
  ivownDocumentId: string | null; ivownDocumentNumber: string | null;
  totals: { amount: number; outstanding: number; chargeCount: number };
  charges: GroupedChargeRow[];
};

export type ChargesSummary = {
  billedTotal: number; postedCount: number; outstandingTotal: number;
  unitsBilled: number; unitsWithActiveTenancy: number;
};

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function useChargesGrouped(month: string, groupBy: "unit" | "statement") {
  return useQuery({
    queryKey: ["billing", "charges", "grouped", { month, groupBy }],
    queryFn: () =>
      apiFetch<{ month: string; groupBy: string; groups: ChargeGroup[] }>(
        `/billing/charges/grouped?month=${month}&groupBy=${groupBy}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useChargesSummary(month: string) {
  return useQuery({
    queryKey: ["billing", "charges", "summary", month],
    queryFn: () => apiFetch<ChargesSummary>(`/billing/charges/summary?month=${month}`),
  });
}

export type ChargesListFilters = {
  page: number; status?: string; counterparty?: "tenant" | "owner";
  month?: string; q?: string; partyId?: string; outstandingOnly?: boolean;
};

export function useChargesList(filters: ChargesListFilters, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["billing", "charges", "page", filters],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(filters.page), pageSize: "25" });
      if (filters.status) params.set("status", filters.status);
      if (filters.counterparty) params.set("counterparty", filters.counterparty);
      if (filters.month) params.set("month", filters.month);
      if (filters.q) params.set("q", filters.q);
      if (filters.partyId) params.set("partyId", filters.partyId);
      if (filters.outstandingOnly) params.set("outstandingOnly", "true");
      return apiFetch<{ data: ChargeListItemV2[]; total: number }>(`/billing/charges?${params}`);
    },
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
  });
}

/** Payer-scoped outstanding pool for the payment drawers (Task 13). */
export function usePayerOutstandingCharges(partyId: string | null) {
  return useQuery({
    queryKey: ["billing", "charges", "outstanding", partyId],
    queryFn: () =>
      apiFetch<{ data: ChargeListItemV2[] }>(`/billing/charges?partyId=${partyId}&outstandingOnly=true`),
    enabled: partyId !== null && partyId !== "",
  });
}
