// Typed React Query hooks for the portal-my-card surface (per spec §6.2).
//
// Query-key prefix is `portal-my-card` per the role-envelope rule (project
// CLAUDE.md): every portal-fetched resource uses a `portal-...` query
// key so it never collides with admin queries that hit `/api/...`.

import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { portalApiFetch, PortalApiError } from "@/lib/portal-api";

// ── DTOs (mirror apps/api/src/modules/portal-my-card/service.ts) ──────────

export interface MyCardVersion {
  id: string;
  displayName: string;
  title: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  status: string; // 'pending' | 'approved' | 'rejected'
  submittedByType: string; // 'admin' | 'agent'
  rejectionReason: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  reconfirmCount: number;
  createdAt: string;
  /** Only present on `active`. Always null on pending/history. */
  publicToken: string | null;
}

export interface MyCardData {
  active: MyCardVersion | null;
  pending: MyCardVersion | null;
  history: MyCardVersion[];
}

export interface SubmitMyCardInput {
  displayName: string;
  title: string;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
}

export interface SubmitMyCardResult {
  versionId: string;
}

export interface ReconfirmMyCardResult {
  versionId: string;
  newExpiresAt: string;
}

export interface WithdrawMyCardResult {
  versionId: string;
}

// ── Query key (single source of truth) ────────────────────────────────────

export const myCardQueryKey = ["portal-my-card"] as const;

// ── Hooks ─────────────────────────────────────────────────────────────────

export function useMyCard() {
  return useQuery<MyCardData>({
    queryKey: myCardQueryKey,
    queryFn: async () => {
      const res = await portalApiFetch<{ data: MyCardData }>("/my-card");
      return res.data;
    },
  });
}

export function useSubmitMyCard(): UseMutationResult<
  SubmitMyCardResult,
  PortalApiError,
  SubmitMyCardInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitMyCardInput) => {
      const res = await portalApiFetch<{ data: SubmitMyCardResult }>("/my-card/submit", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: myCardQueryKey });
    },
  });
}

export function useReconfirmMyCard(): UseMutationResult<
  ReconfirmMyCardResult,
  PortalApiError,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await portalApiFetch<{ data: ReconfirmMyCardResult }>("/my-card/reconfirm", {
        method: "POST",
        body: JSON.stringify({}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: myCardQueryKey });
    },
  });
}

export function useWithdrawMyCard(): UseMutationResult<
  WithdrawMyCardResult,
  PortalApiError,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await portalApiFetch<{ data: WithdrawMyCardResult }>("/my-card/withdraw", {
        method: "POST",
        body: JSON.stringify({}),
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: myCardQueryKey });
    },
  });
}

// ── Helpers used by the page ──────────────────────────────────────────────

/**
 * Days remaining until the card expires. Returns null if no expiresAt.
 * Uses calendar-day math (UTC midnight) so a card that expires "today"
 * shows 0, "tomorrow" shows 1, etc.
 */
export function daysUntilExpiry(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt).getTime();
  const now = Date.now();
  const diffMs = exp - now;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Whether the active card is in the reconfirm window (expires within 30
 * days). Mirrors the service-side rule.
 */
export function isInReconfirmWindow(expiresAt: string | null | undefined): boolean {
  const days = daysUntilExpiry(expiresAt);
  return days !== null && days >= 0 && days <= 30;
}

/**
 * Extracts a structured error body from a PortalApiError so callers can
 * branch on the `code` (e.g. "pending_exists", "cap_reached").
 */
export function getMyCardErrorCode(err: unknown): string | null {
  if (err instanceof PortalApiError) {
    const body = err.body;
    const errField = body?.error;
    if (errField && typeof errField === "object" && "code" in errField) {
      return String(errField.code);
    }
  }
  return null;
}
