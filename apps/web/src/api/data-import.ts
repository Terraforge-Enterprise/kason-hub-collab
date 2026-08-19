/**
 * Data Import (M9) — typed fetchers + React Query hooks.
 *
 * API contract:
 *   GET  /api/data-import/runs        → ImportRun[]  (editor+)
 *   GET  /api/data-import/runs/:id    → ImportRunDetail (editor+)
 *   POST /api/data-import/runs        → DryRunResult  (admin)
 *
 * All gated server-side behind ENABLE_PHASE2_TENANT_TRACKER + RBAC.
 * Committing is intentionally CLI-only — no commit endpoint here.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

// ── Types ────────────────────────────────────────────────────────────────────

export type ImportRunStatus = "running" | "completed" | "failed";

export type ImportRun = {
  id: string;
  dryRun: boolean;
  status: ImportRunStatus;
  rowsParsed: number;
  partiesCreated: number;
  partiesMatched: number;
  tenanciesCreated: number;
  rowsSkipped: number;
  conflicts: number;
  sourceFile: string | null;
  reportKey: string | null;
  triggeredBy: string | null;
  createdAt: string; // ISO-8601
};

/** Detail adds a signed download URL (null when no report was written). */
export type ImportRunDetail = ImportRun & {
  reportUrl: string | null;
};

export type DryRunResult = {
  runId: string;
  counts: {
    rowsParsed: number;
    partiesCreated: number;
    partiesMatched: number;
    tenanciesCreated: number;
    rowsSkipped: number;
    conflicts: number;
  };
  reportKey: string | null;
};

// ── Query key family ─────────────────────────────────────────────────────────

export const DATA_IMPORT_KEY_BASE = ["data-import"] as const;

// ── Queries ──────────────────────────────────────────────────────────────────

/** `GET /api/data-import/runs` — most-recent-first list. */
export function useImportRuns() {
  return useQuery({
    queryKey: [...DATA_IMPORT_KEY_BASE, "runs"],
    queryFn: () => apiFetch<ImportRun[]>("/data-import/runs"),
    staleTime: 30_000,
  });
}

/** `GET /api/data-import/runs/:id` — detail + signed reportUrl. */
export function useImportRun(id: string | null) {
  return useQuery({
    queryKey: [...DATA_IMPORT_KEY_BASE, "runs", id],
    queryFn: () => apiFetch<ImportRunDetail>(`/data-import/runs/${id!}`),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** `POST /api/data-import/runs` with `{ dryRun: true }` — admin only. */
export function useRunDryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<DryRunResult>("/data-import/runs", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: DATA_IMPORT_KEY_BASE }),
  });
}
