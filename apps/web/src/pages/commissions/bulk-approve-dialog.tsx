import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/components/format";

export type BulkApproveCandidate = {
  id: string;
  claimNumber: string;
  agentName: string;
  totalNettPayout: number;
};

type Props = {
  open: boolean;
  candidates: BulkApproveCandidate[];
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
};

export function BulkApproveDialog({ open, candidates, onCancel, onConfirm, isPending }: Props) {
  const total = candidates.reduce((sum, c) => sum + c.totalNettPayout, 0);
  const agents = new Set(candidates.map((c) => c.agentName));
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Approve {candidates.length} claim{candidates.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Totalling <strong>{formatMoney(total)}</strong> to <strong>{agents.size}</strong> agent{agents.size === 1 ? "" : "s"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-48 overflow-auto rounded-md border border-border/50 bg-background/40 p-2 text-xs">
          {candidates.map((c) => (
            <div key={c.id} className="flex justify-between border-b border-border/30 py-1 last:border-b-0">
              <span>
                {c.claimNumber} — {c.agentName}
              </span>
              <span>{formatMoney(c.totalNettPayout)}</span>
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          <Button variant="gold" disabled={isPending} onClick={onConfirm}>
            {isPending ? "Approving…" : `Approve all ${candidates.length}`}
          </Button>
          <Button variant="ghost" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
