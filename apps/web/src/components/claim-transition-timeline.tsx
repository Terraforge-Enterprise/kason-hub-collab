// Shared audit-timeline component for sales + renovation claim transitions.
// Both backends return the same wire shape (apps/api/src/modules/{sales-claims,
// renovation-claims}/...listClaimTransitionsService) so one component covers
// admin claim-detail pages and the portal drawers.

import { CheckCircle2, MessageSquare, RotateCcw, XCircle } from "lucide-react";

export type ClaimTransition = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedById: string;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  submitted: "Submitted",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  needs_amendment: "Needs amendment",
};

function statusLabel(s: string | null): string {
  if (!s) return "—";
  return STATUS_LABEL[s] ?? s;
}

function StatusIcon({ to }: { to: string }) {
  if (to === "approved") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (to === "rejected") return <XCircle className="h-4 w-4 text-rose-500" />;
  if (to === "needs_amendment") return <RotateCcw className="h-4 w-4 text-amber-500" />;
  return <MessageSquare className="h-4 w-4 text-sky-500" />;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function ClaimTransitionTimeline({
  transitions,
  isLoading,
  isError,
  emptyLabel = "No status changes yet.",
}: {
  transitions: ClaimTransition[];
  isLoading?: boolean;
  isError?: boolean;
  emptyLabel?: string;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-12 rounded-md bg-muted/40" />
        <div className="h-12 rounded-md bg-muted/40" />
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-rose-500">
        Failed to load history. Please refresh.
      </p>
    );
  }
  if (transitions.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ol className="space-y-3">
      {transitions.map((t) => (
        <li
          key={t.id}
          className="flex gap-3 rounded-md border border-border/60 bg-background/60 p-3"
        >
          <div className="mt-0.5 shrink-0">
            <StatusIcon to={t.toStatus} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-foreground">
                {statusLabel(t.fromStatus)} → {statusLabel(t.toStatus)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t.changedByName ?? "—"} · {fmtDateTime(t.changedAt)}
              </span>
            </div>
            {t.note ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {t.note}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
