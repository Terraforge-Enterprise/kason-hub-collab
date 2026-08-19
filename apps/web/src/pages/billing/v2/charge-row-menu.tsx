// apps/web/src/pages/billing/v2/charge-row-menu.tsx
// Row ⋯ menu (frontend SKILL §15): Post = AlertDialog restating charge +
// amount + the document that will be minted; Void reuses VoidChargeDialog
// (never a parallel void path); Open PDF only when a document exists.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Send, FileX2, FileText } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { VoidChargeDialog } from "@/components/void-charge-dialog";
import { fetchBillingDocumentPdfUrl } from "@/api/billing-documents";
import { formatMoney } from "@/components/format";

export type ChargeMenuRow = {
  id: string; chargeNumber: string; status: string; displayStatus: string;
  amount: number; currency: string;
  documentId: string | null; documentNumber: string | null;
};

const VOIDABLE = new Set(["posted", "partially_paid", "paid", "draft"]);

export function ChargeRowMenu({ charge }: { charge: ChargeMenuRow }) {
  const qc = useQueryClient();
  const [confirmPost, setConfirmPost] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const post = useMutation({
    mutationFn: () => apiFetch(`/billing/charges/${charge.id}/post`, { method: "POST" }),
    onSuccess: () => {
      toast.success(`${charge.chargeNumber} posted`);
      qc.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (e: Error) => toast.error(e.message || "Failed to post charge"),
  });

  async function openPdf() {
    if (!charge.documentId) return;
    try {
      const url = await fetchBillingDocumentPdfUrl(charge.documentId);
      window.open(url, "_blank", "noopener");
    } catch {
      toast.error("Could not fetch the document PDF");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Charge actions for ${charge.chargeNumber}`}
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {charge.status === "draft" && charge.displayStatus !== "on_statement" && (
            <DropdownMenuItem onClick={() => setConfirmPost(true)}>
              <Send className="mr-2 h-4 w-4" /> Post…
            </DropdownMenuItem>
          )}
          {VOIDABLE.has(charge.status) && (
            <DropdownMenuItem onClick={() => setVoiding(true)}>
              <FileX2 className="mr-2 h-4 w-4" /> Void{charge.status === "draft" ? "…" : " & credit note…"}
            </DropdownMenuItem>
          )}
          {charge.documentId && (
            <DropdownMenuItem onClick={openPdf}>
              <FileText className="mr-2 h-4 w-4" /> Open PDF ({charge.documentNumber})
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmPost} onOpenChange={setConfirmPost}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Post {charge.chargeNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              {formatMoney(charge.amount, charge.currency)} becomes visible and collectable.
              Posting mints its accounting document; undo later is void → credit note.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={post.isPending} onClick={() => post.mutate()}>
              Post charge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <VoidChargeDialog
        charge={voiding ? { id: charge.id, chargeNumber: charge.chargeNumber, status: charge.status } : null}
        onClose={() => setVoiding(false)}
        onDone={() => {
          setVoiding(false);
          qc.invalidateQueries({ queryKey: ["billing"] });
        }}
      />
    </>
  );
}
