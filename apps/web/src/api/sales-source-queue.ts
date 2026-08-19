/**
 * Sales source-queue API client (admin · manager+).
 *
 * Lives in a separate file from `apps/web/src/api/sales.ts` to keep the
 * W3 wave's queue work decoupled from the broader sales pipeline client.
 * Mirrors the endpoints shipped by `apps/api/src/modules/sales/sales.routes.ts`:
 *
 *   GET  /api/sales/source-queue
 *   POST /api/sales/source-queue/:id/approve
 *   POST /api/sales/source-queue/:id/reject              { note }
 *   POST /api/sales/source-queue/:id/needs-amendment     { note }
 *
 * The row shape matches `SalesUnitRow` (Date → string after JSON serialisation),
 * so we re-export the existing `SalesUnit` from sales.ts to avoid type drift.
 */
import { apiFetch } from "@/lib/api-client";
import type { SalesUnit } from "./sales";

export type SalesSourceQueueRow = SalesUnit;

export function listSalesSourceQueue(): Promise<{ data: SalesSourceQueueRow[] }> {
  return apiFetch<{ data: SalesSourceQueueRow[] }>("/sales/source-queue");
}

export function approveSalesSourceQueue(
  id: string,
): Promise<{ data: SalesSourceQueueRow }> {
  return apiFetch<{ data: SalesSourceQueueRow }>(
    `/sales/source-queue/${id}/approve`,
    { method: "POST" },
  );
}

export function rejectSalesSourceQueue(
  id: string,
  note: string,
): Promise<{ data: SalesSourceQueueRow }> {
  return apiFetch<{ data: SalesSourceQueueRow }>(
    `/sales/source-queue/${id}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}

export function needsAmendmentSalesSourceQueue(
  id: string,
  note: string,
): Promise<{ data: SalesSourceQueueRow }> {
  return apiFetch<{ data: SalesSourceQueueRow }>(
    `/sales/source-queue/${id}/needs-amendment`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    },
  );
}
