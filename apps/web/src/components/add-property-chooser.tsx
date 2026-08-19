// Two-option chooser: "For sale" routes to the sales-pipeline create form,
// "For rent" routes to the new portal rental-unit create form. Both
// submissions land in the same source queue server-side.
//
// Per unified-property-sourcing spec §6.2.

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AddPropertyChooser({
  trigger,
}: {
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span onClick={() => setOpen(true)} className="contents">
        {trigger}
      </span>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a property</DialogTitle>
          <DialogDescription>
            Pick how this property will be handled. Both options route the
            submission through the source queue for admin review.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 mt-3">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              // The sales-pipeline page already has a "+ New Entry" button
              // that opens the create drawer. We just navigate there; the
              // pipeline page is responsible for surfacing the create UI.
              navigate("/portal/sales-pipeline");
            }}
            className="flex flex-col items-center gap-2 rounded-xl border border-border/50 bg-background/40 p-6 text-left hover:bg-background/60 transition"
          >
            <FileText className="h-6 w-6 text-primary" />
            <span className="font-semibold">For sale</span>
            <span className="text-xs text-muted-foreground">
              Helping a developer or owner sell their property — sales
              pipeline.
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/portal/inventory/new");
            }}
            className="flex flex-col items-center gap-2 rounded-xl border border-border/50 bg-background/40 p-6 text-left hover:bg-background/60 transition"
          >
            <Building2 className="h-6 w-6 text-primary" />
            <span className="font-semibold">For rent</span>
            <span className="text-xs text-muted-foreground">
              Already-bought property ready (or near-ready) to rent —
              rental inventory.
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
