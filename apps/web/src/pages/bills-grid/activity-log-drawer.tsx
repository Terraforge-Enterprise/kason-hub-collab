import { History, Loader2 } from "lucide-react";
import type { GridRow } from "@/api/bills-grid";
import { useAuditTimeline, type AuditTimelineEntry } from "@/api/audit-log";
import { Callout } from "@/components/ui/callout";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const FIELD_LABELS: Record<string, string> = {
  readingDate: "Reading date",
  cleaningRaw: "Cleaning",
  tnbTotalRaw: "TNB total",
  airSelangorRaw: "Air",
  wifiRaw: "WiFi",
  maintenanceFee: "Maintenance fee",
  paymentStatus: "Payment status",
  previousKwh: "Previous meter (kWh)",
  currentKwh: "Current meter (kWh)",
  amount: "Amount",
  tnbPattern: "TNB pattern",
  airPattern: "Air pattern",
  cleaningBearer: "Cleaning bearer",
  wifiBearer: "WiFi bearer",
  maintenanceFeeBearer: "Maintenance bearer",
};

const ACTION_LABELS: Record<string, string> = {
  "grid.entry.save": "Saved billing values",
  "grid.reading.save": "Saved meter readings",
  "grid.entry.lines": "Changed billing settings",
  "grid.entry.bill": "Billed tenant / owner",
  "grid.entry.rebill": "Re-Billed tenant / owner",
};

type Change = { field?: unknown; before?: unknown; after?: unknown; listingId?: unknown };

function changesOf(entry: AuditTimelineEntry): Change[] {
  if (!entry.diff || typeof entry.diff !== "object") return [];
  const diff = entry.diff as Record<string, unknown>;
  if (Array.isArray(diff.changes)) return diff.changes as Change[];
  // Older Save records stored only the resulting values. Keep them useful and
  // label the missing prior value honestly rather than inventing a before-state.
  return Object.entries(diff)
    .filter(([field]) => field !== "updatedById")
    .map(([field, after]) => ({ field, before: undefined, after }));
}

function displayValue(value: unknown, missing = "Not recorded") {
  if (value === undefined) return missing;
  if (value === null || value === "") return "Empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ActivityItem({ entry }: { entry: AuditTimelineEntry }) {
  const changes = changesOf(entry);
  const actor = entry.actorName ?? `User ${entry.actorUserId.slice(0, 8)}`;
  return (
    <li className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[18px] font-bold text-[var(--navy)]">{ACTION_LABELS[entry.action] ?? entry.action}</p>
          <p className="mt-1 text-[16px] text-[var(--text-muted)]">{actor} · {entry.actorRole}</p>
        </div>
        <time className="text-[15px] font-medium text-[var(--text-muted)]">
          {new Date(entry.createdAt).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </div>
      {changes.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)]">
          {changes.map((change, index) => {
            const field = String(change.field ?? "Value");
            return (
              <div key={`${field}-${index}`} className="grid grid-cols-[minmax(130px,0.8fr)_1fr] gap-3 border-b border-[var(--border)] px-3 py-2.5 text-[16px] last:border-b-0">
                <span className="font-semibold text-[var(--navy)]">{FIELD_LABELS[field] ?? field}</span>
                <span className="min-w-0 break-words text-[var(--text-primary)]">
                  <span className="text-[var(--text-muted)]">{displayValue(change.before)}</span>
                  <span className="mx-2 font-bold text-[var(--gold)]">→</span>
                  <strong>{displayValue(change.after, "Empty")}</strong>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {changes.length === 0 && entry.meta != null && (
        <p className="mt-3 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[15px] text-[var(--text-muted)]">
          Action completed. Detailed field changes were not recorded for this event.
        </p>
      )}
    </li>
  );
}

export function ActivityLogDrawer({ row, onClose }: { row: GridRow | null; onClose: () => void }) {
  const entryId = row?.entryId ?? "";
  const { rows, isLoading, isError, isForbidden } = useAuditTimeline(entryId ? [entryId] : []);
  return (
    <Sheet open={row != null} onOpenChange={(open) => { if (!open) onClose(); }} lockProgress={false}>
      <SheetContent size="lg" className="bg-[var(--page-bg)]">
        <SheetHeader className="bg-white pr-14">
          <SheetTitle className="flex items-center gap-2 text-[24px] text-[var(--navy)]">
            <History className="h-6 w-6 text-[var(--gold)]" /> Activity log
          </SheetTitle>
          <p className="text-[17px] text-[var(--text-muted)]">
            {row ? `${row.propertyName} ${row.unitCode}`.trim() : ""} · newest first
          </p>
        </SheetHeader>
        <SheetBody>
          {!entryId && <Callout variant="info" title="No activity yet">This unit has not been saved for this billing period.</Callout>}
          {isLoading && <div className="flex items-center gap-2 py-8 text-[17px]"><Loader2 className="h-5 w-5 animate-spin" /> Loading activity…</div>}
          {isForbidden && <Callout variant="info" title="Activity is restricted">Manager or Admin access is required.</Callout>}
          {isError && <Callout variant="danger" title="Couldn't load activity">Please try again.</Callout>}
          {!isLoading && entryId && !isError && !isForbidden && rows.length === 0 && (
            <p className="py-10 text-center text-[17px] text-[var(--text-muted)]">No recorded activity yet.</p>
          )}
          {rows.length > 0 && <ol className="space-y-4">{rows.map((entry) => <ActivityItem key={entry.id} entry={entry} />)}</ol>}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
