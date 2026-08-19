// Shared row bits for the tenant tracker (v2): chips, detail fields, PIC
// cell, and the ⋯ action launcher. Moved verbatim from tenant-tracker-page.tsx
// — behavior unchanged (flag-gated launcher items, copy-to-clipboard chip).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, MoreHorizontal, Pencil, Phone } from "lucide-react";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import type { TrackerRoom } from "@kason/shared";
import { StatusPill } from "@/components/ui";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";

export function ContactChip({ icon: Icon, value, copyable = true }: { icon: typeof Phone; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the copy-feedback timer on unmount (filter changes can drop rows
  // mid-flash — no setState on an unmounted component).
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        if (!copyable) return;
        navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1200);
      }}
      className="group/chip inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2 py-0.5 text-xs text-muted-foreground transition hover:border-border hover:bg-background/60 hover:text-foreground"
      title={copyable ? "Copy to clipboard" : value}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{value}</span>
      {copyable && (
        <Copy className={`h-3 w-3 transition ${copied ? "text-emerald-500" : "opacity-0 group-hover/chip:opacity-100"}`} />
      )}
    </button>
  );
}

export function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-foreground">{children}</div>
    </div>
  );
}

/** PIC pill + pencil — shared by occupied and vacant room rows. */
export function PicCell({ room, onEditPic }: { room: TrackerRoom; onEditPic: () => void }) {
  const picName = room.inChargeName ?? room.inChargeParty?.displayName ?? null;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <StatusPill
        tone={PHASE2_STATUS_TONES.pic[picName ? "assigned" : "unassigned"]}
        className="min-w-0 max-w-full shrink"
      >
        <span className="min-w-0 truncate">{picName ?? "Unassigned"}</span>
      </StatusPill>
      <button
        type="button"
        onClick={onEditPic}
        aria-label={`Edit PIC for ${room.unit.listingType} room`}
        title="Assign person-in-charge"
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "shrink-0")}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** The ⋯ row-action launcher. Take-payment item stays dark until its flag flips. */
export function RoomActionsMenu({
  label,
  onAddFee,
}: {
  label: string;
  onAddFee: () => void;
}) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${label}`}
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onAddFee}>Add fee / charge</DropdownMenuItem>
        {isPhase2FlagEnabled("ENABLE_PHASE2_MULTI_PAY") && (
          <DropdownMenuItem onClick={() => navigate("/billing/payments")}>Take payment</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
