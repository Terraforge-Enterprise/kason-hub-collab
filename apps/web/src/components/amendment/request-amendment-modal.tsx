import { useState, useEffect } from "react";
import { Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void | Promise<void>;
  /** Used in the body copy: "...resubmit the {entityLabel}." */
  entityLabel: string;
  /** External busy flag — disables the textarea + buttons while the request is in-flight. */
  busy?: boolean;
}

const MAX_NOTE_LENGTH = 2000;

/**
 * Admin-facing dialog for sending a record back to the agent with a
 * required note. Used by commission-claim admin and source-queue admin
 * (same shape, same copy — only the entityLabel varies).
 *
 * Pure presentation: the parent owns the API call and the busy state.
 */
export function RequestAmendmentModal({
  open,
  onClose,
  onSubmit,
  entityLabel,
  busy = false,
}: Props) {
  const [note, setNote] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (open) setNote("");
  }, [open]);

  const trimmed = note.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_NOTE_LENGTH;

  const handleSubmit = () => {
    if (!valid || busy) return;
    void onSubmit(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send back for amendment</DialogTitle>
          <DialogDescription>
            Tell the agent what needs to change. They'll be able to re-edit and resubmit the {entityLabel}.
          </DialogDescription>
        </DialogHeader>

        <label
          htmlFor="amendment-note"
          className="text-sm font-medium text-foreground"
        >
          Note (required)
        </label>
        <textarea
          id="amendment-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={5}
          maxLength={MAX_NOTE_LENGTH}
          disabled={busy}
          placeholder="e.g. Please attach the signed tenancy agreement PDF"
          className={cn(
            "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none",
            "placeholder:text-muted-foreground",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50",
            "dark:bg-input/30",
          )}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{trimmed.length} / {MAX_NOTE_LENGTH}</span>
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!valid || busy}
          >
            <Send className="h-4 w-4" aria-hidden />
            {busy ? "Sending..." : "Send back"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
