import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type SheetRootProps = DialogPrimitive.Root.Props & {
  /** See Dialog `lockProgress` — defaults to true to protect form drawers from accidental dismiss. */
  lockProgress?: boolean;
};

function Sheet({ onOpenChange, lockProgress = true, ...props }: SheetRootProps) {
  return (
    <DialogPrimitive.Root
      data-slot="sheet"
      onOpenChange={(open, eventDetails) => {
        if (lockProgress && !open && eventDetails.reason === "focus-out") {
          eventDetails.cancel();
          return;
        }
        onOpenChange?.(open, eventDetails);
      }}
      {...props}
    />
  );
}

function SheetTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-backdrop"
      className={cn(
        "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm",
        "data-open:animate-in data-closed:animate-out",
        "data-open:fade-in-0 data-closed:fade-out-0",
        "motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export const sheetSizes = {
  sm:      "md:w-[420px]",          // confirm flows, simple selectors
  md:      "md:w-[520px]",          // single-section forms
  lg:      "md:w-[720px]",          // multi-section forms (FormDrawer default)
  xl:      "md:w-[960px]",          // dense forms with 2-col body
  full:    "md:w-[min(100vw,1200px)]", // detail surfaces adapted to drawer
} as const;

export type SheetSize = keyof typeof sheetSizes;

type SheetContentProps = DialogPrimitive.Popup.Props & { size?: SheetSize };

function SheetContent({
  className,
  children,
  size = "md",
  ...props
}: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetBackdrop />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full flex-col outline-none",
          sheetSizes[size],
          "bg-background/80 backdrop-blur-xl border-l border-border/50 shadow-2xl",
          "data-open:animate-in data-closed:animate-out",
          "data-open:slide-in-from-right data-closed:slide-out-to-right",
          "motion-reduce:animate-none motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
        <SheetClose
          className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Close"
        >
          <XIcon className="h-4 w-4" />
        </SheetClose>
      </DialogPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 border-b border-border/50 p-6", className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("flex-1 overflow-y-auto p-6", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "flex flex-row-reverse items-center gap-2 border-t border-border/50 bg-background/60 backdrop-blur-xl p-4 sticky bottom-0",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
