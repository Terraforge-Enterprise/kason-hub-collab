/**
 * Tenant Tracker (M1) — typed fetchers + React Query hooks.
 * Plan: docs/superpowers/plans/2026-06-11-phase2-tenant-tracker.md (Step 6).
 *
 * All request/response contracts come from @kason/shared
 * (packages/shared/src/schemas/tenant-tracker.ts) — never redefined here.
 *
 * ── CACHE RULES (spec §9 — do-not-conflate) ─────────────────────────────────
 * The `["tenant-tracker"]` key family is invalidated ONLY by:
 *   - PIC assign/unassign (useAssignInCharge below),
 *   - Tenancy CRUD (create/renew/end — owned by the tenancy module),
 *   - Party contact updates (phone/email/name edits),
 *   - Inventory/unit edits (Listing/Apartment changes).
 * It is NEVER invalidated by payment or charge events — those belong to the
 * RENTAL Tracker's cache. Tenant Tracker (who lives where, PIC, contacts) and
 * Rental Tracker (money: payments, charges, invoices) are DIFFERENT domains;
 * wiring payment events into this key would conflate them.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AssignInChargeInput,
  AssignInChargeResult,
  IcRevealBody,
  IcRevealResponse,
  TenantTrackerListQuery,
  TrackerAgentsResponse,
  TrackerListResponse,
  TrackerLookupHit,
  TrackerSummaryResponse,
} from "@kason/shared";
import { API_BASE, ApiError, apiFetch, extractApiError } from "@/lib/api-client";
import { getAdminToken } from "@/lib/auth";

/**
 * Page-level filters = the shared list query minus the pagination params the
 * hooks own internally (`cursor` from React Query's pageParam, `limit` fixed
 * below). `status` stays required — the page always has a concrete tab.
 */
export type TrackerPageFilters = Omit<TenantTrackerListQuery, "cursor" | "limit">;

/**
 * Root of the tenant-tracker query-key family. Exported because the CACHE
 * RULES above obligate three OTHER modules (tenancy CRUD, party-contact
 * updates, inventory/unit edits) to invalidate this family — they must import
 * this constant, never hard-code the string.
 */
export const TRACKER_KEY_BASE = ["tenant-tracker"] as const;
const TRACKER_PAGE_SIZE = 25; // matches the server default (zod .default(25))

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

/**
 * Normalizes filters for use in a query key (and as query-string params).
 *
 * KEY RULE: empty-string entries and pagination params (`cursor`/`limit` —
 * owned by the hooks/export, never key material) are STRIPPED, `undefined`
 * entries dropped, and the remaining keys sorted — so `{status:"active"}`
 * and `{status:"active", agent: ""}` produce structurally identical keys.
 *
 * Note: React Query v5's default hashKey already sorts object keys and drops
 * `undefined` entries when hashing, so the real value of this function is the
 * empty-string + cursor/limit stripping, structural (toEqual) key equality
 * for tests/invalidation predicates, and reuse as the URLSearchParams source.
 */
export function normalizeTrackerKeyFilters(
  filters: TrackerPageFilters,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (key === "cursor" || key === "limit") continue;
    if (value === undefined || value === "") continue;
    if (value === false) continue; // boolean filters are presence-only on the wire
    normalized[key] = String(value);
  }
  return normalized;
}

/**
 * The ⌘K lookup only fires once the input contains at least 4 digits
 * (separators/`+` are ignored when counting) — below that the suffix match
 * is too broad to be useful and just burns requests.
 */
export function isLookupEnabled(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= 4;
}

/** v5 `getNextPageParam`: the API signals "no more pages" with `null`. */
export function nextPageParam(last: TrackerListResponse): string | undefined {
  return last.nextCursor ?? undefined;
}

/**
 * True when an assign-in-charge mutation failed because the Listing changed
 * since the client last read it (server compares `expectedUpdatedAt` and
 * returns 409 `{ error: "STALE" }`). The page should refetch + re-prompt,
 * not blind-retry.
 */
export function isStaleAssignError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * Extracts the filename from a `Content-Disposition: attachment` header.
 * Prefers RFC 6266 `filename*=UTF-8''…`, falls back to plain `filename=`.
 */
export function parseAttachmentFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Infinite grouped-by-apartment tracker list.
 * `GET /api/tenant-tracker` → pages of `TrackerListResponse`.
 */
export function useTenantTrackerInfinite(filters: TrackerPageFilters, opts?: { enabled?: boolean }) {
  const normalized = normalizeTrackerKeyFilters(filters);
  return useInfiniteQuery({
    queryKey: [...TRACKER_KEY_BASE, normalized],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        ...normalized,
        limit: String(TRACKER_PAGE_SIZE),
      });
      if (pageParam) params.set("cursor", pageParam);
      return apiFetch<TrackerListResponse>(`/tenant-tracker?${params.toString()}`);
    },
    getNextPageParam: nextPageParam,
    // Keep the previous filter's pages on screen while the new filter loads —
    // without this every filter change hard-blanks the list (sibling
    // precedent: useUsers in src/api/users.ts).
    placeholderData: (prev) => prev,
    enabled: opts?.enabled ?? true,
  });
}

/**
 * ⌘K phone-search-to-act. `GET /api/tenant-tracker/lookup?phone=` →
 * `TrackerLookupHit[]`. Disabled until the input has ≥ 4 digits.
 * NOTE: the ⌘K consumer debounces the input UPSTREAM — no debounce here.
 */
export function useTenantTrackerLookup(phone: string) {
  return useQuery({
    queryKey: ["tenant-tracker-lookup", phone],
    queryFn: () =>
      apiFetch<TrackerLookupHit[]>(
        `/tenant-tracker/lookup?${new URLSearchParams({ phone }).toString()}`,
      ),
    enabled: isLookupEnabled(phone),
    staleTime: 30_000,
    // Refining an already-resulted query (4 digits → hits → type more) keeps
    // the previous hits on screen instead of flashing results→pending→results.
    placeholderData: keepPreviousData,
  });
}

/**
 * Distinct raw agent labels for the Agent filter dropdown.
 * `GET /api/tenant-tracker/agents` → `TrackerAgentsResponse`.
 * Labels change rarely (only when a tenancy is created/edited with a new
 * label) — generous staleTime keeps the dropdown from refetching per open.
 */
export function useAgentLabels() {
  return useQuery({
    queryKey: ["tenant-tracker-agents"],
    queryFn: () => apiFetch<TrackerAgentsResponse>("/tenant-tracker/agents"),
    staleTime: 5 * 60_000,
  });
}

/**
 * Property rail + header counts. `GET /api/tenant-tracker/summary` →
 * `TrackerSummaryResponse`. Same TRACKER_KEY_BASE family — invalidated by the
 * four allowed invalidators (CACHE RULES above); payments never touch it.
 */
export function useTrackerSummary() {
  return useQuery({
    queryKey: [...TRACKER_KEY_BASE, "summary"],
    queryFn: () => apiFetch<TrackerSummaryResponse>("/tenant-tracker/summary"),
    staleTime: 60_000,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Assign/unassign the room PIC.
 * `PATCH /api/tenant-tracker/:unitId/in-charge` with `AssignInChargeInput`.
 *
 * On 409 the Listing was modified since `expectedUpdatedAt` — detect with
 * `isStaleAssignError(error)` and refetch. No toasts here: the page owns UX.
 */
export function useAssignInCharge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, ...input }: AssignInChargeInput & { unitId: string }) =>
      apiFetch<AssignInChargeResult>(`/tenant-tracker/${unitId}/in-charge`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    // PIC assignment is one of the FOUR allowed invalidators of the
    // tenant-tracker family (see CACHE RULES at the top of this file).
    onSuccess: () => qc.invalidateQueries({ queryKey: TRACKER_KEY_BASE }),
  });
}

/**
 * Audited unmasked-IC reveal (manager+).
 * `POST /api/tenant-tracker/ic-reveal` `{ partyId }` → `IcRevealResponse`.
 *
 * Deliberately performs NO cache writes: the unmasked IC must never enter
 * React Query's cache, where it would linger in memory/devtools and leak via
 * any observer of list data. Every reveal is server-audited, so every read
 * MUST hit the endpoint — the caller renders `data.idNumber` transiently and
 * discards it.
 */
export function useRevealIc() {
  return useMutation({
    mutationFn: (input: IcRevealBody) =>
      apiFetch<IcRevealResponse>("/tenant-tracker/ic-reveal", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}

// ── Export download ──────────────────────────────────────────────────────────

/**
 * Downloads `GET /api/tenant-tracker/export.xlsx` with the current filters
 * (manager+; cursor/limit stripped — the export is unpaginated).
 *
 * Why fetch-blob instead of a plain `<a href>` navigation: api-client auth is
 * bearer-token-first (Authorization header from localStorage) with the cookie
 * as a secondary channel that iOS Safari silently drops — a bare anchor can't
 * carry the header, so we fetch with the same auth convention as apiFetch and
 * download via a same-origin object URL (mirroring lib/download-media.ts).
 */
export async function downloadTrackerExport(filters: TrackerPageFilters): Promise<void> {
  // normalizeTrackerKeyFilters strips cursor/limit — the export is unpaginated.
  const normalized = normalizeTrackerKeyFilters(filters);
  const qs = new URLSearchParams(normalized).toString();
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}/tenant-tracker/export.xlsx${qs ? `?${qs}` : ""}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const { message, code } = extractApiError(body, res.status);
    throw new ApiError(message, res.status, code, body);
  }

  const blob = await res.blob();
  const filename =
    parseAttachmentFilename(res.headers.get("Content-Disposition")) ??
    "tenant-tracker.xlsx";

  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke after a tick — synchronous revocation can race the click and
    // cancel the download (same pattern as lib/download-media.ts).
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
