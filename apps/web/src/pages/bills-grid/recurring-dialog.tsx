// Bills & Expenses Grid — read-only CUSTOM recurring lines dialog (recurring-charges, R9).
// Mirrors expenses-dialog.tsx's read-only itemised view. Recurring amounts are NOT editable
// here — they are settings-controlled (the "Edit in Unit Settings" action opens the settings
// drawer's recurring editor). Cleaning/WiFi are NOT shown here (they have their own columns).
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GlowCard } from "@/components/ui/glow-card";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/components/format";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { listRecurringLines, RECURRING_QUERY_KEY_ROOT } from "@/api/bills-grid-recurring";

export type RecurringDialogProps = {
  apartmentId: string;
  periodMonth: string;
  /** Which recurring cell opened this — the Owner cell shows owner-borne lines, the Tenant cell
   *  tenant-borne ones. The endpoint returns BOTH bearers for the apartment-month (one cached
   *  query serves both cells), so the split has to happen here or a tenant charge is listed and
   *  totalled under "owner recurring". */
  bearer: "owner" | "tenant";
  open: boolean;
  onClose: () => void;
  /** Opens the unit's settings drawer (recurring editor) — the only place amounts change. */
  onEditInSettings?: (apartmentId: string) => void;
};

export function RecurringDialog({ apartmentId, periodMonth, bearer, open, onClose, onEditInSettings }: RecurringDialogProps) {
  const query = useQuery({
    queryKey: [...RECURRING_QUERY_KEY_ROOT, "lines", apartmentId, periodMonth],
    queryFn: () => listRecurringLines(apartmentId, periodMonth),
    enabled: open,
  });
  // Scoped to the bearer whose cell was clicked — mirrors the Expenses dialog, and matches the
  // grid cell's own total/count (both already bearer-split server-side by recurringTotalsByEntry).
  const lines = (query.data?.lines ?? []).filter((l) => l.bearer === bearer);
  const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  // Read-only display only (Task 9) — this dialog never edits; the selector lives in the
  // Unit Settings recurring editor ("Edit in Unit Settings" below). Flag OFF: unchanged.
  const natureRoutingOn = isPhase2FlagEnabled("ENABLE_CHARGE_NATURE_ROUTING");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bearer === "owner" ? "Owner" : "Tenant"} recurring charges</DialogTitle>
        </DialogHeader>

        <GlowCard glowColor="gold" className="p-4 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Total {bearer} recurring</p>
              <p className="text-2xl font-bold tabular-nums text-foreground" data-testid="recurring-dialog-total">{formatMoney(total)}</p>
              <p className="text-xs text-muted-foreground" data-testid="recurring-dialog-count">{lines.length} line{lines.length === 1 ? "" : "s"}</p>
            </div>
          </div>
        </GlowCard>

        <div className="space-y-2">
          {query.isPending && open ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recurring charges for this month.</p>
          ) : (
            lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{l.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {l.categoryName}
                    {" · "}
                    <Badge variant={l.bearer === "owner" ? "sky" : "emerald"}>{l.bearer}</Badge>
                    {natureRoutingOn && l.nature && (
                      <>
                        {" "}
                        <Badge variant={l.nature === "expense" ? "amber" : "gold"}>{l.nature}</Badge>
                      </>
                    )}
                  </p>
                </div>
                <p className="text-sm tabular-nums text-foreground">{formatMoney(Number(l.amount))}</p>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          {onEditInSettings && (
            <Button type="button" variant="outline" className="gap-2" onClick={() => { onEditInSettings(apartmentId); onClose(); }}>
              <Pencil className="h-4 w-4" />
              Edit in Unit Settings
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
