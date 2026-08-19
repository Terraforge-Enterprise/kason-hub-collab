import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * Generic pending-changes diff drawer.
 *
 * Renders a side-by-side "Current → Proposed" table for every key in
 * `pendingChanges` whose value differs from `current[key]`. Used by the
 * admin source-queue page (and any other surface that needs to review
 * agent-submitted edits before merging them into a row).
 *
 * Diff is shallow: keys not present in `current` show "—" for the
 * before-value, which is the correct behavior for slim list rows that
 * don't carry every field of the underlying record.
 */
type Diffable = Record<string, unknown>;

interface PendingDiffDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Diffable;
  pendingChanges: Diffable | null;
  onApprove: () => void;
  onReject: () => void;
  approveBusy?: boolean;
  rejectBusy?: boolean;
}

function diffEntries(current: Diffable, pendingChanges: Diffable | null) {
  if (!pendingChanges) return [];
  return Object.entries(pendingChanges)
    .filter(([key, next]) => current[key] !== next)
    .map(([key, next]) => ({ field: key, before: current[key], after: next }));
}

function fmt(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function PendingDiffDrawer(props: PendingDiffDrawerProps) {
  const entries = diffEntries(props.current, props.pendingChanges);

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Pending changes</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-3 px-6">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No diffable changes.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-3">Field</th>
                  <th className="pb-2 pr-3">Current</th>
                  <th className="pb-2">Proposed</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.field} className="border-t border-border">
                    <td className="py-2 pr-3 font-medium">{e.field}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{fmt(e.before)}</td>
                    <td className="py-2">{fmt(e.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-6 flex gap-2 px-6 pb-6">
          <Button onClick={props.onApprove} disabled={props.approveBusy}>
            {props.approveBusy ? "Approving…" : "Approve all"}
          </Button>
          <Button variant="ghost" onClick={props.onReject} disabled={props.rejectBusy}>
            {props.rejectBusy ? "Rejecting…" : "Reject all"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
