/**
 * CardApprovalSheet — admin diff + decision drawer for one pending
 * AgentCardVersion. Per spec §7.0 + §7.1, the review surface is a
 * `<Sheet>` slide-over (NOT a stacked panel) and the destructive
 * "Reject" action confirms via `<AlertDialog>` with a required reason.
 *
 * Diff layout (per design pass):
 *   ┌──────────────────────┬──────────────────────┐
 *   │ Currently approved   │ Proposed             │
 *   │ (emerald 'live' pill)│ (amber 'pending' pill)
 *   ├──────────────────────┼──────────────────────┤
 *   │ Name / Title /       │ same row schema, but │
 *   │ Email / Phone        │ changed cells render │
 *   │                      │ in amber font-medium │
 *   └──────────────────────┴──────────────────────┘
 *
 * Token-rotation copy in the description: per spec §6.1, an agent-
 * submitted approval ROTATES the public token (so the agent's
 * un-approved link they may have shared dies); an admin-submitted
 * approval PRESERVES the token. We surface this in the description so
 * the manager understands the side-effect before clicking Approve.
 *
 * The Sheet's outer state is controlled by the parent (the page owns
 * `reviewVersionId`); this component is purely presentational +
 * mutation-driving.
 */
import { useState } from "react";
import { toast } from "sonner";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type AgentCardVersion,
  useAgentCardHistory,
  useAgentCardVersion,
  useApproveCard,
  useRejectCard,
} from "@/api/agent-cards";

interface Props {
  versionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CardApprovalSheet({ versionId, open, onOpenChange }: Props) {
  const { data: proposed, isLoading } = useAgentCardVersion(versionId);
  const { data: history } = useAgentCardHistory(proposed?.partyId);
  const active = history?.find((v) => v.status === "approved");

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const approve = useApproveCard();
  const reject = useRejectCard();

  const handleApprove = () => {
    if (!versionId || !proposed) return;
    approve.mutate(versionId, {
      onSuccess: () => {
        toast.success(`Approved ${proposed.displayName}'s e-namecard`);
        onOpenChange(false);
      },
      onError: (err) => {
        toast.error(`Approve failed: ${err.message}`);
      },
    });
  };

  const handleReject = () => {
    if (!versionId || !proposed) return;
    const reason = rejectReason.trim();
    if (!reason) return;
    reject.mutate(
      { versionId, reason },
      {
        onSuccess: () => {
          toast.success(`Rejected ${proposed.displayName}'s e-namecard`);
          setRejectOpen(false);
          setRejectReason("");
          onOpenChange(false);
        },
        onError: (err) => {
          toast.error(`Reject failed: ${err.message}`);
        },
      },
    );
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent size="lg" className="overflow-hidden">
          <SheetHeader>
            <SheetTitle>
              {proposed
                ? `Review: ${proposed.displayName}`
                : "Review submission"}
            </SheetTitle>
            <SheetDescription>
              {proposed ? (
                <>
                  Submitted {new Date(proposed.createdAt).toLocaleString()} by{" "}
                  <span className="font-medium">
                    {proposed.submittedByType}
                  </span>
                  .{" "}
                  {proposed.submittedByType === "agent"
                    ? "Approving will ROTATE the public link — any link the agent already shared from this submission will stop working."
                    : "Approving will preserve the existing public link."}
                </>
              ) : (
                "Loading submission…"
              )}
            </SheetDescription>
          </SheetHeader>

          <SheetBody className="space-y-4">
            {isLoading || !proposed ? (
              <div className="space-y-2">
                <div className="h-6 bg-muted rounded animate-pulse" />
                <div className="h-32 bg-muted rounded animate-pulse" />
              </div>
            ) : (
              <div className="rounded-lg border border-border/50 bg-background/40 overflow-hidden">
                <div className="grid grid-cols-2 divide-x divide-border/50">
                  <div className="p-3 flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground bg-background/40">
                    Currently approved <Badge variant="emerald">live</Badge>
                  </div>
                  <div className="p-3 flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground bg-background/40">
                    Proposed <Badge variant="amber">pending</Badge>
                  </div>
                </div>
                <DiffRow
                  label="Name"
                  oldV={active?.displayName ?? null}
                  newV={proposed.displayName}
                />
                <DiffRow
                  label="Title"
                  oldV={active?.title ?? null}
                  newV={proposed.title}
                />
                <DiffRow
                  label="Email"
                  oldV={active?.primaryEmail ?? null}
                  newV={proposed.primaryEmail}
                />
                <DiffRow
                  label="Phone"
                  oldV={active?.primaryPhone ?? null}
                  newV={proposed.primaryPhone}
                />
              </div>
            )}
          </SheetBody>

          <SheetFooter>
            <Button
              variant="gold"
              onClick={handleApprove}
              disabled={!proposed || approve.isPending}
            >
              {approve.isPending ? "Approving…" : "Approve & Publish"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setRejectOpen(true)}
              disabled={!proposed}
            >
              Reject…
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={rejectOpen}
        onOpenChange={(next, details) => {
          // Only close on explicit button-click — preserve typed reason
          // if the user tabs away accidentally.
          if (!next && details?.reason !== "close-press") return;
          setRejectOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this submission?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will see your reason in their portal and can edit
              and re-submit. Be specific so they don't re-submit the same
              thing.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/*
            No `<Textarea>` primitive exists in apps/web/src/components/ui
            yet, and adding one is out of scope for this phase. We use a
            styled native textarea matching the Input primitive's styling
            (border-input, focus-ring, transition). When a Textarea
            primitive lands, swap this for it.
          */}
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. Title 'CEO' requires 5+ years tenure — currently 2 years. Re-submit after Aug 2026."
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30 resize-y min-h-[72px]"
          />
          <div className="text-xs text-muted-foreground mt-1 text-right">
            {rejectReason.length}/500
          </div>

          <AlertDialogFooter>
            <AlertDialogAction
              render={(props) => (
                <Button
                  variant="destructive"
                  {...props}
                  onClick={(e) => {
                    handleReject();
                    props.onClick?.(e);
                  }}
                  disabled={!rejectReason.trim() || reject.isPending}
                >
                  {reject.isPending ? "Rejecting…" : "Send rejection"}
                </Button>
              )}
            />
            <AlertDialogCancel
              render={(props) => (
                <Button
                  variant="ghost"
                  {...props}
                  onClick={(e) => {
                    setRejectOpen(false);
                    props.onClick?.(e);
                  }}
                >
                  Cancel
                </Button>
              )}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DiffRow({
  label,
  oldV,
  newV,
}: {
  label: string;
  oldV: string | null;
  newV: string | null;
}) {
  const changed = (oldV ?? null) !== (newV ?? null);
  return (
    <div className="grid grid-cols-2 divide-x divide-border/50 border-t border-border/50">
      <div className="p-3 text-sm">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
          {label}
        </div>
        <div
          className={
            changed
              ? "text-muted-foreground line-through decoration-rose-400/60"
              : "text-foreground"
          }
        >
          {oldV || "—"}
        </div>
      </div>
      <div className="p-3 text-sm">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
          &nbsp;
        </div>
        <div
          className={
            changed
              ? "text-amber-600 dark:text-amber-400 font-medium"
              : "text-muted-foreground"
          }
        >
          {newV || "—"}
        </div>
      </div>
    </div>
  );
}

// Re-export AgentCardVersion type so consumers can keep imports tight.
export type { AgentCardVersion };
