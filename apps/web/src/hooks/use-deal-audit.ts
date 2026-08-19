import { useQuery } from "@tanstack/react-query";
import type { DealAuditResponse } from "@kason/shared";
import { apiFetch } from "@/lib/api-client";

/**
 * Fetches the read-only Deal Audit view — claims grouped by
 * (property + unit + room + move-in + tenant), with per-deal totals
 * (tenant side, listing side, combined, company residual, TA shortfall).
 *
 * Server enforces Manager+ via requireRole("manager") on the route.
 */
export function useDealAudit(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ["commissions", "deal-audit", page, pageSize] as const,
    queryFn: () =>
      apiFetch<DealAuditResponse>(
        `/commissions/deal-audit?page=${page}&pageSize=${pageSize}`,
      ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}
