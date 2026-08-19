/**
 * UnitDetailDrawer (Task 3) — click-a-unit drill-down drawer.
 *
 * Shows:
 *  – Header: "<unitCode> — <total> tickets" + propertyName
 *  – Recurring callout (warning) per recurring category, if any
 *  – Problems breakdown: unit.byCategory (window-scoped canonical + count)
 *  – Ticket list from useUnitMiniStat().data.tickets — each row shows
 *    category · status pill · ageDays · opened date, with a link to /tasks
 *  – Loading skeleton + empty state
 *
 * Drawer primitive: Sheet (same as statement-detail-sheet.tsx and other
 * admin detail surfaces in this codebase).
 *
 * Ticket links: the only ticket-detail surface is the Tasks board at /tasks.
 * No URL-based deep link is supported by that page, so each ticket links to
 * /tasks (the admin will find the ticket on the board). The UnitTicketRow.id
 * is the Ticket primary key; future deep-link support can enrich this.
 */

import { Link } from "react-router-dom";
import { BarChart3, CalendarDays, Clock, ExternalLink, Tag } from "lucide-react";
import type { AnalyticsWindow, UnitAnalyticsRow } from "@kason/shared";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui";
import { Callout } from "@/components/ui/callout";
import { formatDate } from "@/components/format";
import { useUnitMiniStat } from "@/api/analytics";

// ── Ticket status → StatusPill tone ──────────────────────────────────────────

type TicketTone = "slate" | "sky" | "emerald" | "amber" | "rose";

function ticketStatusTone(status: string): TicketTone {
  const map: Record<string, TicketTone> = PHASE2_STATUS_TONES.ticket as Record<string, TicketTone>;
  return map[status] ?? "slate";
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function DrawerSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      {/* callout placeholder */}
      <div className="h-10 bg-muted rounded-lg" />
      {/* breakdown header */}
      <div className="h-5 w-40 bg-muted rounded" />
      {/* breakdown pills */}
      <div className="flex flex-wrap gap-2">
        <div className="h-7 w-24 bg-muted rounded-full" />
        <div className="h-7 w-20 bg-muted rounded-full" />
      </div>
      {/* ticket list header */}
      <div className="h-5 w-32 bg-muted rounded" />
      {/* ticket rows */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-12 bg-muted rounded-lg" />
      ))}
    </div>
  );
}

// ── Drawer body (rendered once data is available) ─────────────────────────────

interface DrawerBodyProps {
  unit: UnitAnalyticsRow;
  window: AnalyticsWindow;
}

function DrawerBody({ unit, window }: DrawerBodyProps) {
  const query = useUnitMiniStat(unit.unitId, window);

  if (query.isPending) {
    return <DrawerSkeleton />;
  }

  const tickets = query.data?.data.tickets ?? [];
  const windowLabel = window === "all" ? "all time" : `the last ${window}`;

  return (
    <div className="space-y-6">
      {/* ── Recurring callout (one per recurring category) ─────────────────── */}
      {unit.recurringCategories.length > 0 && (
        <div className="space-y-2">
          {unit.recurringCategories.map((cat) => (
            <Callout key={cat} variant="warning">
              Repeated {cat} tickets in {windowLabel} — ≥3 occurrences flagged.
            </Callout>
          ))}
        </div>
      )}

      {/* ── Problems breakdown ─────────────────────────────────────────────── */}
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
          <Tag className="h-3 w-3" />
          Problems breakdown
        </p>
        {unit.byCategory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No category data.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {unit.byCategory.map((cat) => (
              <span
                key={cat.canonical}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-3 py-1 text-sm"
              >
                <StatusPill tone={cat.recurring ? "amber" : "slate"}>
                  {cat.canonical}
                </StatusPill>
                <span className="font-semibold tabular-nums text-foreground">
                  {cat.count}
                </span>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Ticket list ────────────────────────────────────────────────────── */}
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          Tickets in window ({tickets.length})
        </p>

        {tickets.length === 0 ? (
          <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-6 text-center">
            <BarChart3 className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No tickets in this window.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tickets.map((ticket) => (
              <Link
                key={ticket.id}
                to="/tasks"
                className="flex items-start justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
                aria-label={`View ticket: ${ticket.title} (${ticket.categoryCanonical}, ${ticket.status})`}
              >
                <div className="flex flex-col gap-1 min-w-0">
                  {/* Category + status */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">
                      {ticket.categoryCanonical}
                    </span>
                    <StatusPill tone={ticketStatusTone(ticket.status)}>
                      {ticket.status}
                    </StatusPill>
                  </div>
                  {/* Age + opened date */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {ticket.ageDays}d
                    </span>
                    <span className="flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      {formatDate(ticket.createdAt)}
                    </span>
                  </div>
                </div>
                <ExternalLink className="ml-3 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition mt-1" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────────

export interface UnitDetailDrawerProps {
  unit: UnitAnalyticsRow | null;
  window: AnalyticsWindow;
  open: boolean;
  onClose: () => void;
}

export default function UnitDetailDrawer({
  unit,
  window,
  open,
  onClose,
}: UnitDetailDrawerProps) {
  return (
    <Sheet
      open={open && unit !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      lockProgress={false}
    >
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            {unit ? `${unit.unitCode} — ${unit.total} tickets` : "Unit detail"}
          </SheetTitle>
          <SheetDescription>
            {unit?.propertyName ?? ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {open && unit ? (
            <DrawerBody unit={unit} window={window} />
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
