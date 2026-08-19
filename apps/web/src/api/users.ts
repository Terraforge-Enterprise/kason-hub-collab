import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

export type OperatorUser = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  mustChangePassword: boolean;
  photoUrl: string | null;
  // Party.id for the operator's individual party (always non-null after the
  // 2026-05-23 backfill; older orphans get null until backfilled).
  partyId: string | null;
  // Current upline of the operator's party — used by the admin drawer to
  // pre-fill the Upline picker.
  party: {
    id: string;
    uplineId: string | null;
    upline: { id: string; displayName: string } | null;
  } | null;
};

export type CreateUserInput = {
  email: string;
  fullName: string;
  role: "manager" | "editor" | "viewer";
  password: string;
};

export type UpdateUserInput = {
  fullName?: string;
  role?: "manager" | "editor" | "viewer";
};

export type ResetPasswordInput = {
  password: string;
};

type UserRole = "admin" | "manager" | "editor" | "viewer";

const USERS_KEY_BASE = ["users"] as const;

function usersKey(roles?: UserRole[]) {
  return roles?.length
    ? ([...USERS_KEY_BASE, { roles: [...roles].sort() }] as const)
    : USERS_KEY_BASE;
}

export function useUsers(opts?: { roles?: UserRole[] }) {
  const queryString = opts?.roles?.length ? `?roles=${opts.roles.join(",")}` : "";
  return useQuery({
    queryKey: usersKey(opts?.roles),
    queryFn: () => apiFetch<{ data: OperatorUser[] }>(`/users${queryString}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      apiFetch<{ data: { id: string } }>("/users", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY_BASE }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateUserInput & { id: string }) =>
      apiFetch<{ ok: boolean }>(`/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY_BASE }),
  });
}

export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean }>(`/users/${id}/deactivate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY_BASE }),
  });
}

export function useActivateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean }>(`/users/${id}/activate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY_BASE }),
  });
}

/**
 * PUT /parties/:partyId/upline — sets / clears the upline of any party
 * (agent or staff individual). Used by the admin drawer to place
 * managers/editors in the reporting tree.
 */
export function useSetPartyUpline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ partyId, uplineId }: { partyId: string; uplineId: string | null }) =>
      apiFetch<{ ok: boolean; updatedAt: string }>(`/parties/${partyId}/upline`, {
        method: "PUT",
        body: JSON.stringify({ uplineId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: USERS_KEY_BASE });
      qc.invalidateQueries({ queryKey: ["agent-hierarchy"] });
      qc.invalidateQueries({ queryKey: ["upline-typeahead"] });
    },
  });
}

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      apiFetch<{ ok: boolean }>(`/users/${id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: USERS_KEY_BASE }),
  });
}
