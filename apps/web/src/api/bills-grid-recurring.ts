// Bills & Expenses Grid — recurring-charge settings client (recurring-charges feature).
// Typed wrappers over the Manager-gated recurring endpoints (routes.ts §5b) + the editor's
// read + the grid dialog's per-period line read. Mirrors api/bills-grid.ts's apiFetch style.
import { apiFetch, ApiError } from "@/lib/api-client";
import type {
  RecurringApplyInput,
  RecurringApplyResult,
  RecurringDefinitionDto,
  RecurringLineDto,
  RecurringPreview,
  RecurringUpsertInput,
} from "@kason/shared";

export const RECURRING_QUERY_KEY_ROOT = ["bills-grid", "recurring"] as const;

/** A 409 from apply/disable carries the per-period conflicts (block-all, nothing applied). */
export interface RecurringConflictError {
  status: 409;
  conflicts: RecurringPreview["conflicts"];
  message: string;
}

/** Nature routing (ENABLE_CHARGE_NATURE_ROUTING, Task 9): the apply body may carry an
 * explicit Expense/Profit nature. Client-local extension of the shared RecurringApplyInput —
 * mirrors the API's route-local `recurringApplyWithNatureSchema` (bills-grid/routes.ts), kept
 * out of @kason/shared for the same reason: only THIS endpoint accepts it (preview and the
 * disable/archive callers never carry nature). `nature` is optional on the wire — the flag-ON
 * fail-closed 422 (NATURE_REQUIRED) is enforced server-side; callers must still always resolve
 * a concrete value before invoking this while the flag is ON (default "profit" — see
 * recurring-settings.tsx). */
export type RecurringApplyBody = RecurringApplyInput & { nature?: "expense" | "profit" };

/** GET recurring — every definition + its revisions (settings editor). */
export function listRecurring(apartmentId: string): Promise<{ definitions: RecurringDefinitionDto[] }> {
  return apiFetch(`/bills-grid/apartments/${apartmentId}/recurring`);
}

/** POST recurring/preview — read-only preview of what an apply would change. */
export function previewRecurring(apartmentId: string, body: RecurringUpsertInput): Promise<RecurringPreview> {
  return apiFetch(`/bills-grid/apartments/${apartmentId}/recurring/preview`, { method: "POST", body: JSON.stringify(body) });
}

/** POST recurring/apply — creates the revision + syncs open periods atomically. A 409 rejects
 * with `{ conflicts }` (nothing applied) — surfaced as a thrown RecurringConflictError. */
export async function applyRecurring(apartmentId: string, body: RecurringApplyBody): Promise<RecurringApplyResult> {
  try {
    return await apiFetch(`/bills-grid/apartments/${apartmentId}/recurring/apply`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const data = e.data as { conflicts?: RecurringPreview["conflicts"]; error?: string } | undefined;
      const conflict: RecurringConflictError = { status: 409, conflicts: data?.conflicts ?? [], message: data?.error ?? "recurring_conflict" };
      throw conflict;
    }
    throw e;
  }
}

/** POST recurring/:definitionId/disable — effective-dated disable + sync. */
export function disableRecurring(apartmentId: string, definitionId: string): Promise<RecurringApplyResult> {
  return apiFetch(`/bills-grid/apartments/${apartmentId}/recurring/${definitionId}/disable`, { method: "POST" });
}

/** POST recurring/:definitionId/archive — archive the definition + strip open-period snapshots. */
export function archiveRecurring(apartmentId: string, definitionId: string): Promise<{ id: string }> {
  return apiFetch(`/bills-grid/apartments/${apartmentId}/recurring/${definitionId}/archive`, { method: "POST" });
}

/** GET recurring/lines?period= — the read-only materialized recurring lines for the dialog. */
export function listRecurringLines(apartmentId: string, period: string): Promise<{ lines: RecurringLineDto[] }> {
  return apiFetch(`/bills-grid/apartments/${apartmentId}/recurring/lines?period=${encodeURIComponent(period)}`);
}

/** Type guard for the apply/disable 409-conflict rejection. */
export function isRecurringConflict(e: unknown): e is RecurringConflictError {
  return typeof e === "object" && e !== null && (e as { status?: number }).status === 409 && Array.isArray((e as { conflicts?: unknown }).conflicts);
}
