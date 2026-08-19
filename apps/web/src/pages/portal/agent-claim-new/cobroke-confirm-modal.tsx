import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export type CobrokeConfirmItem = {
  condoName: string;
  unitCode: string;
  roomType: string;
  commissionSharePercent: string;
  taSharePercent: string;
};

export function CobrokeConfirmModal({
  open,
  items,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  items: CobrokeConfirmItem[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Confirm cobroke items
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p>You&apos;re submitting as cobroke on:</p>
          <ul className="list-disc pl-5 space-y-1">
            {items.map((it) => (
              <li key={`${it.unitCode}-${it.roomType}`}>
                <span className="font-medium">{it.condoName}</span> · {it.unitCode} · {it.roomType}
                <span className="text-muted-foreground">
                  {" "}— commission {it.commissionSharePercent}%, TA {it.taSharePercent}%
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Your partner(s) must file their own claim for the remaining share on each of these items.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}>Confirm &amp; submit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
