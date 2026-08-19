import { portalApiFetch } from "@/lib/portal-api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type PortalSession = {
  userId: string;
  userType: "tenant" | "agent" | "owner";
  partyId: string;
  orgId: string;
  mustChangePassword: boolean;
};

export const portalSessionKey = ["portal-auth", "me"] as const;

export async function fetchPortalSession(): Promise<PortalSession> {
  const res = await portalApiFetch<{ data: PortalSession }>("/auth/me");
  return res.data;
}

export function usePortalSession(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: portalSessionKey,
    queryFn: fetchPortalSession,
    enabled: opts?.enabled ?? true,
    retry: false,
  });
}

export function useChangePortalPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      // `token` is the rotated session — the server re-issues it so the user
      // stays signed in on the new password. Absent only when the account has
      // no partyId; the existing cookie still authenticates either way.
      portalApiFetch<{ ok: boolean; message: string; token?: string }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalSessionKey }),
  });
}

// ─── Password reset helpers (raw portalApiFetch — not react-query) ─────────

export async function portalForgotPassword(email: string): Promise<{ message: string }> {
  return portalApiFetch<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
    redirectOnUnauthorized: false,
  });
}

export async function portalVerifyResetToken(token: string): Promise<{ ok: true; fullName: string }> {
  return portalApiFetch<{ ok: true; fullName: string }>("/auth/verify-reset-token", {
    method: "POST",
    body: JSON.stringify({ token }),
    redirectOnUnauthorized: false,
  });
}

export async function portalResetPassword(token: string, password: string): Promise<{ ok: true; message: string }> {
  return portalApiFetch<{ ok: true; message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
    redirectOnUnauthorized: false,
  });
}
