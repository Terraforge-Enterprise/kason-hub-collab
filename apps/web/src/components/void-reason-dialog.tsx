/**
 * VoidReasonDialog — destructive confirm WITH a mandatory reason textarea
 * (spec §4.3: reason mandatory, min 3 chars, on every posted-state void).
 * ConfirmAlert cannot host inputs, so statement / statement-line / utility-bill
 * voids use this once ENABLE_PHASE2_BILLING_DOCS is on.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, TextAreaInput } from "@/components/form-ui";

export function VoidReasonDialog({
  open,
  title,
  body,
  confirmLabel = "Void & issue Credit Note",
  onCancel,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  pending?: boolean;
}) {
  const [reason, setReason] = useState("");
  // Reset the reason at every dismissal point (backdrop/Escape via
  // onOpenChange, the Cancel button, and the open→false transition) rather
  // than via an effect keyed on `open` — this dialog is parent-controlled
  // and stays mounted between opens. Confirm deliberately does NOT reset:
  // some callers (e.g. billing-pane's void dialog) keep the dialog open on
  // mutation error so the admin can retry, and clearing the reason there
  // would force a retype after a transient failure. The true-close case is
  // instead caught below via the React-docs "adjusting state during render"
  // pattern (not useEffect — that would be setState-in-effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (!open) setReason("");
  }
  function dismiss() {
    setReason("");
    onCancel();
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <Field label="Reason">
          <TextAreaInput
            aria-label="Reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being voided? (required)"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || pending}
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            {pending ? "Voiding…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
