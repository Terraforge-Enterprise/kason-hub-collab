import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TenancyListItem } from "./tenancies-table";

export function CancelRenewalDialog({
  tenancy,
  open,
  onOpenChange,
}: {
  tenancy: TenancyListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");

  const handleOpenChange = (next: boolean) => {
    if (cancel.isPending) return;
    if (!next) {
      setReason("");
      setMessage("");
      cancel.reset();
    }
    onOpenChange(next);
  };

  const cancel = useMutation({
    mutationFn: () => apiFetch<{ data: { voidedCharges: number; voidedInvoices: number; cancelledAgreements: number } }>(
      `/tenancy/tenancies/${tenancy!.id}/cancel-renewal`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tenancy"] }),
        queryClient.invalidateQueries({ queryKey: ["action-centre"] }),
        queryClient.invalidateQueries({ queryKey: ["bills-grid"] }),
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
      ]);
      setMessage(`Renewal cancelled safely. ${result.data.voidedCharges} draft charge(s), ${result.data.voidedInvoices} draft bill(s), and ${result.data.cancelledAgreements} agreement version(s) were retained as cancelled history.`);
    },
    onError: (error: Error) => setMessage(error.message),
  });

  if (!tenancy) return null;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <Ban className="h-6 w-6 text-red-600" /> Cancel planned renewal
          </DialogTitle>
          <DialogDescription className="text-base">
            {tenancy.propertyName} {tenancy.unitCode} · {tenancy.tenantName} · starts {tenancy.startDate.slice(0, 10)}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-[var(--navy-text)]">
          The renewed tenancy will remain in history as <strong>Cancelled</strong>. The original tenancy is restored, and only unissued draft rent / TA charges are voided. Nothing is hard-deleted.
        </div>
        <label className="mt-5 block text-sm font-bold text-[var(--navy-text)]">
          Cancellation reason
          <textarea
            className="mt-2 min-h-28 w-full rounded-lg border border-[var(--border)] bg-white p-3 text-base dark:bg-card"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Example: Tenant changed their mind and will move out at the original tenancy end date."
          />
        </label>
        {message ? (
          <div className={`mt-4 rounded-lg border p-3 text-sm font-semibold ${cancel.isSuccess ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
            {message}
          </div>
        ) : null}

        <DialogFooter>
          {cancel.isSuccess ? (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending || reason.trim().length < 5}>
                {cancel.isPending ? "Cancelling…" : "Confirm cancellation"}
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={cancel.isPending}>Keep renewal</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
