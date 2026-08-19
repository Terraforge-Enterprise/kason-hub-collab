// apps/web/src/pages/billing/v2/payment-row-menu.tsx
// Row ⋯ menu (frontend SKILL §15). Approve = manager gate server-side;
// Void reverses applied allocations (server) — AlertDialog spells that out.
// Allocate… is affordance-scoped (final-review fix wave): allocatePaymentBatchTx
// claims the payment's idempotencyKey ONCE (compare-and-set on null) — a payment
// that already carries a key (record-and-allocate, or a settled FPX payment) 409s
// on any further allocate-batch attempt, and once a payment's allocations already
// cover its amount there's no headroom left either. Show the item only when
// there's actually room for it: posted, no batch key yet, and Σ allocations <
// amount.
// NOTE: this repo's DropdownMenuTrigger renders its OWN <button> (no asChild —
// style it directly via buttonVariants, see task-action-menu.tsx) and
// DropdownMenuItem fires `onClick`, not `onSelect`.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, CheckCircle2, Ban, Undo2, ListPlus } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { postPayment } from "@/api/payments";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, TextAreaInput } from "@/components/form-ui";

export type PaymentMenuRow = {
  id: string; paymentNumber: string; partyId: string; status: string;
  amount: number; currency: string; hasBatchKey: boolean; allocatedTotal: number;
};

type Confirm = null | "approve" | "void" | "refunded";

export function PaymentRowMenu({
  payment,
  onAllocate,
}: {
  payment: PaymentMenuRow;
  onAllocate: (p: PaymentMenuRow) => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [note, setNote] = useState("");

  const hasAnyAction =
    payment.status === "pending_approval" ||
    payment.status === "posted";

  const canAllocate =
    payment.status === "posted" &&
    !payment.hasBatchKey &&
    payment.allocatedTotal < payment.amount - 0.005;

  const done = (msg: string) => {
    toast.success(msg);
    setConfirm(null);
    setNote("");
    qc.invalidateQueries({ queryKey: ["payments"] });
    qc.invalidateQueries({ queryKey: ["billing"] });
  };

  const approve = useMutation({
    mutationFn: () => postPayment(payment.id),
    onSuccess: () => done(`${payment.paymentNumber} approved`),
    onError: (e: Error) => toast.error(e.message || "Approve failed"),
  });
  const setStatus = useMutation({
    // `note` travels through mutate()'s variables (captured synchronously at
    // click time) rather than the outer closure — AlertDialogAction is the
    // same base-ui Close primitive as Cancel, so the click that submits also
    // fires onOpenChange, which clears `note` state for the "closed without
    // submitting" case. Reading `note` live from the closure here would race
    // that clear and can ship an empty reason.
    mutationFn: ({ status, note }: { status: "void" | "refunded"; note: string }) =>
      apiFetch(`/payments/${payment.id}/status`, { method: "PUT", body: JSON.stringify({ status, note }) }),
    onSuccess: (_d, vars) => done(`${payment.paymentNumber} ${vars.status === "void" ? "voided" : "marked refunded"}`),
    onError: (e: Error) => toast.error(e.message || "Update failed"),
  });

  // Void/refunded payments have no further actions — an empty "..." menu
  // is worse than no menu at all.
  if (!hasAnyAction) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Payment actions for ${payment.paymentNumber}`}
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {payment.status === "pending_approval" && (
            <DropdownMenuItem onClick={() => setConfirm("approve")}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Approve…
            </DropdownMenuItem>
          )}
          {canAllocate && (
            <DropdownMenuItem onClick={() => onAllocate(payment)}>
              <ListPlus className="mr-2 h-4 w-4" /> Allocate…
            </DropdownMenuItem>
          )}
          {(payment.status === "posted" || payment.status === "pending_approval") && (
            <DropdownMenuItem onClick={() => setConfirm("void")}>
              <Ban className="mr-2 h-4 w-4" /> Void…
            </DropdownMenuItem>
          )}
          {payment.status === "posted" && (
            <DropdownMenuItem onClick={() => setConfirm("refunded")}>
              <Undo2 className="mr-2 h-4 w-4" /> Mark refunded…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            // Closing without submitting (Cancel, backdrop, Esc) — clear the
            // reason so the next confirm dialog (a different payment, or the
            // same one reopened) doesn't inherit stale text.
            setConfirm(null);
            setNote("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "approve" ? `Approve ${payment.paymentNumber}?` :
               confirm === "void" ? `Void ${payment.paymentNumber}?` :
               `Mark ${payment.paymentNumber} refunded?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "approve"
                ? "Applies its recorded allocations to the charges."
                : confirm === "void"
                  ? "Reverses every applied allocation and restores the charges' outstanding amounts."
                  : "Records the money as returned. Reverses any applied allocations and restores the charges' outstanding amounts."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm !== "approve" && (
            <Field label="Reason">
              <TextAreaInput aria-label="Reason" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </Field>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={approve.isPending || setStatus.isPending}
              onClick={() =>
                confirm === "approve"
                  ? approve.mutate()
                  : setStatus.mutate({ status: confirm as "void" | "refunded", note })
              }
            >
              {confirm === "approve" ? "Approve payment" : confirm === "void" ? "Void payment" : "Mark refunded"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
