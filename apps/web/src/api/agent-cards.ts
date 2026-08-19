/**
 * Agent E-Namecard — admin API client.
 *
 * Phase 3 added the read-only history hook (`useAgentCardHistory`).
 * Phase 4 (this commit) adds the moderation queue + mutation hooks
 * required by the Card Approvals page and the agent-detail
 * Regenerate / Revoke buttons.
 *
 * Per spec §6.1, the admin reads NEVER include `publicToken` — the secret
 * is only minted/served via the public envelope (`/public-api/card/:token`)
 * or returned ONCE inline from the dedicated `regenerate-token` mutation
 * (so the admin can copy + share it with the agent).
 */
import { apiFetch } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AgentCardVersion {
  id: string;
  organizationId: string;
  partyId: string;
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  /**
   * 'pending' | 'approved' | 'rejected'.
   * Backend stores as a free-form string column so older statuses (e.g.
   * a future 'revoked' state) wouldn't break this client. Treat as a
   * narrow union for rendering and fall back to the raw string for
   * unknown values.
   */
  status: "approved" | "pending" | "rejected" | (string & {});
  submittedById: string;
  submittedByType: "admin" | "agent" | (string & {});
  reviewedById: string | null;
  /** ISO 8601 string after JSON serialization (Prisma Date → string). */
  reviewedAt: string | null;
  rejectionReason: string | null;
  // publicToken intentionally omitted from admin reads (per Phase 3-backend
  // decision, spec §6.1). The server's VERSION_SELECT does not return it.
  approvedAt: string | null;
  expiresAt: string | null;
  reconfirmCount: number;
  createdAt: string;
}

/**
 * Version history (newest first) for a single agent. Empty array when the
 * party has no card versions yet OR when the partyId belongs to another
 * org (the server returns 200 with [] for both cases — cross-org rows are
 * filtered at the WHERE clause, not surfaced as 404, to avoid an
 * enumeration leak per spec §6.1 file-header comment).
 */
export function useAgentCardHistory(partyId: string | null | undefined) {
  return useQuery<AgentCardVersion[]>({
    queryKey: ["agent-cards", partyId],
    queryFn: async () => {
      const res = await apiFetch<{ data: AgentCardVersion[] }>(
        `/agent-cards/${partyId}`,
      );
      return res.data;
    },
    enabled: !!partyId,
  });
}

// ── Phase 4: queue list + single-version detail ─────────────────────────

export interface AgentCardListResponse {
  data: AgentCardVersion[];
  pagination: { total: number; limit: number; offset: number };
}

/**
 * Pending-count badge counter for the sidebar / Card Approvals tab pill.
 * 30s `staleTime` so revisiting the page doesn't re-poll the count
 * gratuitously; React Query still refetches on focus by default which
 * keeps the badge "fresh enough" without a websocket.
 */
export function usePendingCardCount() {
  return useQuery<{ count: number }>({
    queryKey: ["agent-cards", "_meta", "pending-count"],
    queryFn: async () => {
      const res = await apiFetch<{ data: { count: number } }>(
        "/agent-cards/_meta/pending-count",
      );
      return res.data;
    },
    staleTime: 30_000,
  });
}

/**
 * Paginated card-version list scoped to the caller org. Defaults to
 * `status=pending` because the queue page is the dominant consumer; pass
 * `status: "approved"` etc. for other surfaces.
 *
 * Note: the server returns `{ data, pagination }` directly (NOT wrapped in
 * a `{ data: { data, pagination } }` envelope), so we type the apiFetch
 * generic to match and return the response as-is.
 */
export function useAgentCardsList(
  opts: {
    status?: "pending" | "approved" | "rejected";
    limit?: number;
    offset?: number;
  } = {},
) {
  const { status = "pending", limit = 50, offset = 0 } = opts;
  return useQuery<AgentCardListResponse>({
    queryKey: ["agent-cards", "list", status, limit, offset],
    queryFn: () =>
      apiFetch<AgentCardListResponse>(
        `/agent-cards?status=${status}&limit=${limit}&offset=${offset}`,
      ),
  });
}

/** Single-version detail (used by the Card Approvals diff Sheet). */
export function useAgentCardVersion(versionId: string | null | undefined) {
  return useQuery<AgentCardVersion>({
    queryKey: ["agent-cards", "version", versionId],
    queryFn: async () => {
      const res = await apiFetch<{ data: AgentCardVersion }>(
        `/agent-cards/version/${versionId}`,
      );
      return res.data;
    },
    enabled: !!versionId,
  });
}

// ── Phase 4: manager-gated mutations ────────────────────────────────────
//
// Each mutation invalidates the broad `["agent-cards"]` prefix so list,
// history, single-version, AND pending-count queries all refresh after a
// state change. We don't optimistically update the cache because the
// server is the source of truth for the new active row + audit trail.

export interface ApproveCardResult {
  versionId: string;
}
export interface RejectCardResult {
  versionId: string;
}
/** The ONLY admin response that includes `publicToken` (per spec §6.1). */
export interface RegenerateCardTokenResult {
  versionId: string;
  publicToken: string;
}
export interface RevokeCardResult {
  versionId: string;
}

export function useApproveCard() {
  const qc = useQueryClient();
  return useMutation<ApproveCardResult, Error, string>({
    mutationFn: async (versionId) => {
      const res = await apiFetch<{ data: ApproveCardResult }>(
        `/agent-cards/version/${versionId}/approve`,
        { method: "POST", body: JSON.stringify({}) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-cards"] }),
  });
}

export function useRejectCard() {
  const qc = useQueryClient();
  return useMutation<RejectCardResult, Error, { versionId: string; reason: string }>({
    mutationFn: async ({ versionId, reason }) => {
      const res = await apiFetch<{ data: RejectCardResult }>(
        `/agent-cards/version/${versionId}/reject`,
        { method: "POST", body: JSON.stringify({ reason }) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-cards"] }),
  });
}

export function useRegenerateCardToken() {
  const qc = useQueryClient();
  return useMutation<RegenerateCardTokenResult, Error, string>({
    mutationFn: async (partyId) => {
      const res = await apiFetch<{ data: RegenerateCardTokenResult }>(
        `/agent-cards/${partyId}/regenerate-token`,
        { method: "POST", body: JSON.stringify({}) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-cards"] }),
  });
}

export function useRevokeCard() {
  const qc = useQueryClient();
  return useMutation<RevokeCardResult, Error, string>({
    mutationFn: async (partyId) => {
      const res = await apiFetch<{ data: RevokeCardResult }>(
        `/agent-cards/${partyId}/revoke`,
        { method: "POST", body: JSON.stringify({}) },
      );
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-cards"] }),
  });
}
