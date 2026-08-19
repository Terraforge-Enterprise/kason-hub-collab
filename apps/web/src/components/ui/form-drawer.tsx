import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  type SheetSize,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert, type ConfirmSpec } from "@/components/ui/confirm-alert";

/**
 * FormDrawer — opinionated wrapper for input-bearing side drawers.
 *
 * **Role-envelope rule.** This is presentational only. It does NOT import,
 * pre-bake, or know about: API modules, query keys, mutation hooks, role
 * checks. Each calling page owns those separately. Sales claims (portal
 * agent) and commission claims (admin manager) are the same backend row
 * but stay disjoint at the data layer — see `apps/web/src/api/sales-claims.ts`
 * for the rule. Do not collapse those layers via this primitive.
 */

type CalloutVariant = "info" | "warning" | "danger" | "success";

export type FormDrawerAction = {
  label: string;
  pendingLabel?: string;
  /** Omit for the primary submit (which fires `onSubmit`). */
  onClick?: () => void;
  /** Mirrors Button's variant union so consumers can pick any styling without forking. */
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link" | "gold";
  icon?: LucideIcon;
  pending?: boolean;
  disabled?: boolean;
  /** When set, click opens an AlertDialog; the action runs only on Confirm. */
  confirm?: ConfirmSpec;
};

export type FormDrawerProps = {
  open: boolean;
  onClose: () => void;
  size?: SheetSize;
  title: string;
  description?: React.ReactNode;
  warning?: { variant: CalloutVariant; title?: string; body: React.ReactNode };
  onSubmit: () => void | Promise<void>;
  submit?: FormDrawerAction;
  secondaryActions?: Array<FormDrawerAction | false | null | undefined>;
  children: React.ReactNode;
};

type PendingConfirm = { spec: ConfirmSpec; run: () => void } | null;

export function FormDrawer({
  open, onClose, size = "lg",
  title, description, warning,
  onSubmit, submit, secondaryActions, children,
}: FormDrawerProps) {
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);

  const filteredSecondaries = (secondaryActions ?? []).filter(
    (a): a is FormDrawerAction => Boolean(a),
  );

  function runAction(action: FormDrawerAction, defaultRun: () => void) {
    const run = action.onClick ?? defaultRun;
    if (action.confirm) {
      setPendingConfirm({ spec: action.confirm, run });
    } else {
      run();
    }
  }

  function runPrimary() {
    if (!submit) return;
    if (submit.confirm) {
      setPendingConfirm({
        spec: submit.confirm,
        run: () => (submit.onClick ?? onSubmit)(),
      });
    } else if (submit.onClick) {
      submit.onClick();
    } else {
      onSubmit();
    }
  }

  function renderAction(
    action: FormDrawerAction,
    key: string,
    handler: () => void,
    isPrimary: boolean,
  ) {
    const Icon = action.icon;
    const label = action.pending && action.pendingLabel ? action.pendingLabel : action.label;
    // Primary plain submit (no confirm, no onClick) keeps type="submit" so the
    // form's onSubmit fires for click AND Enter — and onSubmit routes through
    // runPrimary, honoring the confirm gate for both inputs.
    const plainPrimary = isPrimary && !action.onClick && !action.confirm;
    return (
      <Button
        key={key}
        type={plainPrimary ? "submit" : "button"}
        variant={action.variant ?? "gold"}
        disabled={action.disabled || action.pending}
        onClick={(e) => {
          if (!plainPrimary) {
            e.preventDefault();
            handler();
          }
        }}
      >
        {Icon ? <Icon className="h-4 w-4" /> : null}
        {label}
      </Button>
    );
  }

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
        <SheetContent size={size}>
          <form
            className="flex h-full flex-col"
            onSubmit={(e) => { e.preventDefault(); runPrimary(); }}
          >
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              {description ? <SheetDescription>{description}</SheetDescription> : null}
            </SheetHeader>
            <SheetBody>
              {warning ? (
                <Callout variant={warning.variant} title={warning.title} className="mb-4">
                  {warning.body}
                </Callout>
              ) : null}
              {children}
            </SheetBody>
            <SheetFooter>
              {/* SheetFooter is flex-row-reverse — primary on the right visually */}
              {submit ? renderAction(submit, "primary", runPrimary, true) : null}
              {filteredSecondaries.map((a, i) =>
                renderAction(a, `secondary-${i}`, () => runAction(a, onSubmit), false),
              )}
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <ConfirmAlert
        open={pendingConfirm !== null}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const ctx = pendingConfirm;
          setPendingConfirm(null);
          ctx?.run();
        }}
        title={pendingConfirm?.spec.title ?? ""}
        body={pendingConfirm?.spec.body ?? ""}
        confirmLabel={pendingConfirm?.spec.confirmLabel ?? "Confirm"}
        destructive={pendingConfirm?.spec.destructive}
      />
    </>
  );
}
