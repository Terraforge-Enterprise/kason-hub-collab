import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import {
  useResourceInvalidation,
  handleMutationError,
} from "@/lib/resource-mutations";

type ClaimLike = { id: string; claimNumber: string };

export function useClaimActions() {
  const invalidate = useResourceInvalidation(["commissions", "claims"]);

  const undo = useMutation({
    mutationFn: (claim: ClaimLike) =>
      apiFetch(`/commissions/claims/${claim.id}/undo-approve`, { method: "POST" }),
    onSuccess: (_data, claim) => {
      invalidate();
      toast(`Undo successful — ${claim.claimNumber} back to submitted`);
    },
    onError: (err: Error, claim) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Undo failed for ${claim.claimNumber}`,
      });
    },
  });

  const approve = useMutation({
    mutationFn: (vars: { claim: ClaimLike; dueDate?: string }) =>
      apiFetch(`/commissions/claims/${vars.claim.id}/approve`, {
        method: "POST",
        body: JSON.stringify(vars.dueDate ? { dueDate: vars.dueDate } : {}),
      }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.success(`Claim ${vars.claim.claimNumber} approved`, {
        action: { label: "Undo", onClick: () => undo.mutate(vars.claim) },
        duration: 5000,
      });
    },
    onError: (err: Error, vars) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Failed to approve ${vars.claim.claimNumber}`,
      });
    },
  });

  const reject = useMutation({
    mutationFn: (vars: { claim: ClaimLike; reason: string }) =>
      apiFetch(`/commissions/claims/${vars.claim.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: vars.reason }),
      }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.success(`Claim ${vars.claim.claimNumber} rejected`);
    },
    onError: (err: Error, vars) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Failed to reject ${vars.claim.claimNumber}`,
      });
    },
  });

  const pay = useMutation({
    mutationFn: (vars: { claim: ClaimLike; movementDate: string; paymentTender: string }) =>
      apiFetch(`/commissions/claims/${vars.claim.id}/pay`, {
        method: "POST",
        body: JSON.stringify({ movementDate: vars.movementDate, paymentTender: vars.paymentTender }),
      }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.success(`Payment recorded for ${vars.claim.claimNumber}`);
    },
    onError: (err: Error, vars) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Failed to record payment for ${vars.claim.claimNumber}`,
      });
    },
  });

  // Re-approve an amended claim — manager+ only (enforced server-side). Flips
  // `amended` → `approved`. The server rejects any other source status.
  const reApprove = useMutation({
    mutationFn: (claim: ClaimLike) =>
      apiFetch(`/commissions/claims/${claim.id}/re-approve`, { method: "POST" }),
    onSuccess: (_data, claim) => {
      invalidate();
      toast.success(`Claim ${claim.claimNumber} re-approved`);
    },
    onError: (err: Error, claim) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Failed to re-approve ${claim.claimNumber}`,
      });
    },
  });

  // Send a claim back to the agent for amendment — manager+ only. Accepts
  // submitted, approved, or amended as source state. Reverses the Bill side-
  // effect server-side when source was approved/amended.
  const needsAmendment = useMutation({
    mutationFn: (vars: { claim: ClaimLike; note: string }) =>
      apiFetch(`/commissions/claims/${vars.claim.id}/needs-amendment`, {
        method: "POST",
        body: JSON.stringify({ note: vars.note }),
      }),
    onSuccess: (_data, vars) => {
      invalidate();
      toast.success(`Claim ${vars.claim.claimNumber} sent back for amendment`);
    },
    onError: (err: Error, vars) => {
      handleMutationError(err, invalidate, {
        fallbackMessage: `Failed to send back ${vars.claim.claimNumber}`,
      });
    },
  });

  return { approve, undo, reject, pay, reApprove, needsAmendment };
}
