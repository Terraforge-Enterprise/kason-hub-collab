// Activity tab body (invoice-adjustments Phase 1.4, spec §7-A9) — a merged,
// newest-first timeline of audit-log events for this invoice AND every linked
// CN/DN/RN document id (a note-issue event is recorded on the NOTE's entityId,
// not the invoice's — see useAuditTimeline). Manager+ only server-side; a
// lower-role viewer sees a plain "restricted" note instead of a fetch error.
import { Loader2 } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { useAuditTimeline } from "@/api/audit-log";
import { formatDateTimeMY } from "@/components/format";

export function ActivityTab({ entityIds }: { entityIds: string[] }) {
  const { rows, isLoading, isError, isForbidden } = useAuditTimeline(entityIds);

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
      </div>
    );
  }

  if (isForbidden) {
    return (
      <Callout variant="info" title="Activity is restricted">
        Viewing this document's activity history requires Manager or Admin access.
      </Callout>
    );
  }

  if (isError) {
    return (
      <Callout variant="danger" title="Couldn't load activity">
        Please try again in a moment.
      </Callout>
    );
  }

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No recorded activity yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {rows.map((r) => (
        <li key={r.id} className="flex gap-3 rounded-lg border border-border/50 bg-background/40 p-3">
          <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{r.action}</p>
            <p className="text-xs text-muted-foreground">
              {r.actorName ?? r.actorUserId.slice(0, 8)} · {formatDateTimeMY(r.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
