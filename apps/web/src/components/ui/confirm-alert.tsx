import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export type ConfirmSpec = {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
};

type ConfirmAlertProps = ConfirmSpec & {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * ConfirmAlert — declarative wrapper around AlertDialog for hard-to-reverse
 * actions. Use this instead of `window.confirm` (which is banned by ESLint).
 *
 * Pages typically don't render this directly — `<FormDrawer>` consumes it
 * via its action.confirm prop. Use directly only when you need a confirm
 * outside a drawer (e.g. a row-menu Delete).
 *
 * Dispatch contract: base-ui's AlertDialogAction / AlertDialogCancel are
 * Close primitives — clicking either closes the dialog and fires
 * onOpenChange(false, { reason: "close-press" }). We use the reason
 * argument to disambiguate: "close-press" means an explicit button was
 * clicked (and its onClick already routed to onConfirm/onCancel), so
 * onOpenChange does nothing. Anything else (Escape, outside click,
 * focus-out, undefined in test envs) is ambient dismissal → onCancel.
 */
export function ConfirmAlert({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  destructive,
}: ConfirmAlertProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        // close-press = an AlertDialogAction/Cancel was clicked; the explicit
        // onClick on those buttons already routed onConfirm/onCancel. Anything
        // else (Escape, outside click, focus-out) is ambient dismissal → cancel.
        if (details?.reason === "close-press") return;
        onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            render={(props) => (
              <Button
                variant={destructive ? "destructive" : "gold"}
                {...props}
                onClick={(event) => {
                  onConfirm();
                  props.onClick?.(event);
                }}
              >
                {confirmLabel}
              </Button>
            )}
          />
          <AlertDialogCancel
            render={(props) => (
              <Button
                variant="ghost"
                {...props}
                onClick={(event) => {
                  onCancel();
                  props.onClick?.(event);
                }}
              >
                Cancel
              </Button>
            )}
          />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
