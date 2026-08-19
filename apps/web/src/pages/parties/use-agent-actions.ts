import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import {
  createResourceMutations,
  useResourceInvalidation,
  handleMutationError,
} from "@/lib/resource-mutations";
import type { AgentListItem } from "./agents-table";

const useAgentMutations = createResourceMutations<AgentListItem>({
  resource: "parties/agents",
  queryKey: ["agents"],
  toasts: {
    create: "Agent created",
    update: "Saved",
    conflict: "Record changed — reloaded",
  },
});

export function useAgentActions() {
  const { create: _create, update: _update } = useAgentMutations();
  const invalidate = useResourceInvalidation(["agents"]);
  const queryClient = useQueryClient();

  // All caches that depend on agent records. The managers page filters to
  // agentLevel='leader' via a separate ["managers"] query — if we only
  // invalidate ["agents"] on mutation, the Managers view stays stale until
  // a manual refresh. Keep this list in one place so no future action path
  // forgets a cache.
  const invalidateAgentViews = () => {
    invalidate();
    queryClient.invalidateQueries({ queryKey: ["managers"] });
    queryClient.invalidateQueries({ queryKey: ["agent-hierarchy"] });
    queryClient.invalidateQueries({ queryKey: ["agent-typeahead"] });
  };

  // Wrap create so a new leader-level agent immediately shows on Managers.
  const create = {
    ..._create,
    mutate: (
      vars: Parameters<typeof _create.mutate>[0],
      opts?: Parameters<typeof _create.mutate>[1],
    ) => {
      _create.mutate(vars, {
        ...opts,
        onSuccess: (...args) => {
          invalidateAgentViews();
          opts?.onSuccess?.(...args);
        },
      });
    },
    mutateAsync: _create.mutateAsync,
  };

  // Wrap update so level changes propagate to Managers + hierarchy + typeahead.
  const update = {
    ..._update,
    mutate: (
      vars: Parameters<typeof _update.mutate>[0],
      opts?: Parameters<typeof _update.mutate>[1],
    ) => {
      _update.mutate(vars, {
        ...opts,
        onSuccess: (...args) => {
          invalidateAgentViews();
          opts?.onSuccess?.(...args);
        },
      });
    },
    mutateAsync: _update.mutateAsync,
  };

  const blacklist = useMutation({
    mutationFn: (vars: { id: string; reason: string; updatedAt: string }) =>
      apiFetch(`/parties/agents/${vars.id}/blacklist`, {
        method: "POST",
        body: JSON.stringify({ reason: vars.reason, updatedAt: vars.updatedAt }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Agent blacklisted");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to blacklist agent",
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: (vars: { id: string; note: string; updatedAt: string }) =>
      apiFetch(`/parties/agents/${vars.id}/reactivate`, {
        method: "POST",
        body: JSON.stringify({ note: vars.note, updatedAt: vars.updatedAt }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Agent reactivated");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to reactivate agent",
      });
    },
  });

  const deactivate = useMutation({
    mutationFn: (vars: { id: string; note: string; updatedAt: string }) =>
      apiFetch(`/parties/agents/${vars.id}/deactivate`, {
        method: "POST",
        body: JSON.stringify({ note: vars.note, updatedAt: vars.updatedAt }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Agent deactivated");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to deactivate agent",
      });
    },
  });

  const activate = useMutation({
    mutationFn: (vars: { id: string; note: string; updatedAt: string }) =>
      apiFetch(`/parties/agents/${vars.id}/activate`, {
        method: "POST",
        body: JSON.stringify({ note: vars.note, updatedAt: vars.updatedAt }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Agent activated");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to activate agent",
      });
    },
  });

  const grantPortal = useMutation({
    mutationFn: (vars: { id: string; email: string; password: string; fullName: string }) =>
      apiFetch(`/parties/${vars.id}/portal-access`, {
        method: "POST",
        body: JSON.stringify({ email: vars.email, password: vars.password, fullName: vars.fullName }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Portal access granted");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to grant portal access",
      });
    },
  });

  const revokePortal = useMutation({
    mutationFn: (vars: { id: string; updatedAt: string }) =>
      apiFetch(`/parties/${vars.id}/portal-access`, {
        method: "DELETE",
        body: JSON.stringify({ updatedAt: vars.updatedAt }),
      }),
    onSuccess: () => {
      invalidateAgentViews();
      toast.success("Portal access revoked");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to revoke portal access",
      });
    },
  });

  const resetPortal = useMutation({
    mutationFn: (vars: { id: string; password: string }) =>
      apiFetch(`/parties/${vars.id}/reset-portal-password`, {
        method: "POST",
        body: JSON.stringify({ password: vars.password }),
      }),
    onSuccess: () => {
      toast.success("Portal password reset");
    },
    onError: (err: Error) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: "Failed to reset portal password",
      });
    },
  });

  return { create, update, blacklist, reactivate, deactivate, activate, grantPortal, revokePortal, resetPortal };
}
