// Audit-log client for the invoice-adjustments Activity tab (spec §7-A9).
//
// GET /api/audit-log filters by a SINGLE entityId (apps/api/src/modules/audit/
// audit.types.ts) and is manager+ role-gated server-side (audit.routes.ts). A
// credit/debit-note issue event is recorded against the NOTE's entityId
// (credit-notes.service.ts: `entityId: cn.id`), not the invoice's — so an
// invoice-only query silently misses note-owned events. The Activity tab must
// therefore query the invoice id AND every linked note id and merge client-side;
// there is no `entityId=in:[...]` filter to do this server-side in one call.
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client";

export type AuditTimelineEntry = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  createdAt: string;
};

type AuditLogListResponse = {
  rows: AuditTimelineEntry[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * Merged, newest-first audit timeline for an invoice plus its linked CN/DN/RN
 * document ids. Deduplicates ids before firing requests (a related document can
 * legitimately repeat across callers). `isForbidden` surfaces a 403 distinctly
 * from a generic fetch failure, since the route is manager+ only — a lower-role
 * viewer of the drawer should see "restricted", not "failed to load".
 */
export function useAuditTimeline(entityIds: string[]) {
  const ids = Array.from(new Set(entityIds.filter(Boolean)));
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["audit-log", "entity", id],
      queryFn: () => apiFetch<AuditLogListResponse>(`/audit-log?entityId=${encodeURIComponent(id)}&pageSize=50`),
      enabled: ids.length > 0,
      retry: false,
    })),
  });

  const isLoading = ids.length > 0 && queries.some((q) => q.isLoading);
  const allFailed = ids.length > 0 && queries.every((q) => q.isError);
  const isForbidden = allFailed && queries.every((q) => q.error instanceof ApiError && q.error.status === 403);
  const isError = allFailed && !isForbidden;

  const rows = queries
    .flatMap((q) => q.data?.rows ?? [])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return { rows, isLoading, isError, isForbidden };
}
