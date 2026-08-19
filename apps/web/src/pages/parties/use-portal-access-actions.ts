import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";

export function usePortalAccessActions(partyId: string, kind: "owner" | "tenant") {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["parties", `${kind}s`, partyId] });
    void qc.invalidateQueries({ queryKey: [`${kind}s`] });
  };

  const grant = useMutation({
    mutationFn: (v: { email: string; password: string; fullName: string }) =>
      apiFetch(`/parties/${partyId}/portal-access`, {
        method: "POST",
        body: JSON.stringify(v),
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Portal access granted");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to grant portal access"),
  });

  const reset = useMutation({
    mutationFn: (v: { password: string }) =>
      apiFetch(`/parties/${partyId}/reset-portal-password`, {
        method: "POST",
        body: JSON.stringify(v),
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Portal password reset");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to reset portal password"),
  });

  const revoke = useMutation({
    mutationFn: (v: { updatedAt: string }) =>
      apiFetch(`/parties/${partyId}/portal-access`, {
        method: "DELETE",
        body: JSON.stringify(v),
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Portal access revoked");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to revoke portal access"),
  });

  return { grant, reset, revoke };
}
