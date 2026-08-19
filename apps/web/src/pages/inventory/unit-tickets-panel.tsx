// Unit-detail "Tickets & History" section (M7 Task 9). Renders its own
// house-style section Card (gold-bar header) so the page edit stays a 3-line
// flag-gated insert. Tickets tab: filterable EnhancedDataTable + TicketDrawer;
// History tab: STRICTLY READ-ONLY chronological timeline (immutable log) +
// QuickLogDialog for new entries.
import { useEffect, useState } from "react";
import { FileText, Plus, Video, X } from "lucide-react";
import { PHASE2_STATUS_TONES, type TicketStatus } from "@kason/shared";
import { StatusPill } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { PillBar } from "@/components/ui/pill-bar";
import { Callout } from "@/components/ui/callout";
import { TextInput } from "@/components/form-ui";
import { EnhancedDataTable } from "@/components/data-table";
import { formatDate } from "@/components/format";
import {
  useUnitHistory,
  useUnitHistoryAttachmentUrls,
  useUnitTickets,
  type AttachmentUrl,
  type TicketRow,
} from "@/api/tasks";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { useUnitMiniStat } from "@/api/analytics";
import { TicketDrawer } from "./ticket-drawer";
import { QuickLogDialog } from "./quick-log-dialog";

type PanelTab = "tickets" | "history";
type WarrantyView = "all" | "warranty";

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  void: "Void",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ─── Phase-2 mini-stat block (inert when ENABLE_PHASE2_UNIT_ANALYTICS is off) ─

const UNIT_ANALYTICS_FLAG = "ENABLE_PHASE2_UNIT_ANALYTICS" as const;

function UnitMiniStatBlock({ unitId }: { unitId: string }) {
  const { data, isLoading } = useUnitMiniStat(unitId);

  // Loading: render nothing (avoid layout shift for a transient state)
  if (isLoading) return null;

  const stat = data?.data;
  if (!stat) return null;

  const { total, open, byCategory, recurringCategories } = stat;

  if (total === 0) {
    return (
      <p
        data-testid="unit-mini-stat"
        className="text-xs text-muted-foreground"
      >
        No problems logged
      </p>
    );
  }

  // Build compact label: "8 problems · 1 open"
  const parts = [`${total} ${total === 1 ? "problem" : "problems"}`, `${open} open`];

  // Recurring categories: find window counts from byCategory for display
  const recurringBadges = recurringCategories.map((cat) => {
    const match = byCategory.find(
      (c) => c.canonical.toLowerCase() === cat.toLowerCase(),
    );
    const count = match?.count ?? 0;
    return { cat, count };
  });

  return (
    <div
      data-testid="unit-mini-stat"
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>{parts.join(" · ")}</span>
      {recurringBadges.map(({ cat, count }) => (
        <Badge
          key={cat}
          variant="destructive"
          className="text-[10px] font-semibold capitalize"
          data-testid="recurring-badge"
        >
          {cat} recurring{count > 0 ? ` (×${count})` : ""}
        </Badge>
      ))}
    </div>
  );
}

export function UnitTicketsPanel({ unitId }: { unitId: string }) {
  const [tab, setTab] = useState<PanelTab>("tickets");
  const [statuses, setStatuses] = useState<TicketStatus[]>([]);
  const [warrantyView, setWarrantyView] = useState<WarrantyView>("all");
  const [categoryInput, setCategoryInput] = useState("");
  const debouncedCategory = useDebounced(categoryInput, 300);
  // null = closed; { ticket: null } = create; { ticket } = edit.
  const [drawer, setDrawer] = useState<{ ticket: TicketRow | null } | null>(null);
  const [quickLogOpen, setQuickLogOpen] = useState(false);

  const ticketsQuery = useUnitTickets(unitId, {
    // PillBar is multi-select; the API takes a single status. Exactly one
    // selection narrows server-side; 2+ narrows client-side below (mirrors
    // the tasks board's priority filter convention).
    status: statuses.length === 1 ? statuses[0] : undefined,
    category: debouncedCategory || undefined,
    warrantyFlag: warrantyView === "warranty" ? "true" : undefined,
  });

  const tickets = ticketsQuery.data?.data ?? [];
  const visibleTickets =
    statuses.length > 1 ? tickets.filter((t) => statuses.includes(t.status)) : tickets;

  return (
    <>
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5 space-y-5">
          {/* Gold-bar section header + tab switch + per-tab primary action */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="w-[3px] h-[16px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#D4AF37]">
                Tickets & History
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Segmented<PanelTab>
                ariaLabel="Tickets & history view"
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "tickets", label: "Tickets" },
                  { value: "history", label: "History" },
                ]}
              />
              {tab === "tickets" ? (
                <Button variant="gold" size="sm" onClick={() => setDrawer({ ticket: null })}>
                  <Plus className="h-4 w-4" /> New Ticket
                </Button>
              ) : (
                <Button variant="gold" size="sm" onClick={() => setQuickLogOpen(true)}>
                  <Plus className="h-4 w-4" /> Add Entry
                </Button>
              )}
            </div>
          </div>

          {/* Phase-2 per-unit mini-stat — gated; hook does NOT fire when flag is off */}
          {isPhase2FlagEnabled(UNIT_ANALYTICS_FLAG) ? (
            <UnitMiniStatBlock unitId={unitId} />
          ) : null}

          {tab === "tickets" ? (
            <>
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </span>
                  <PillBar<TicketStatus>
                    ariaLabel="Status filter"
                    size="sm"
                    value={statuses}
                    onChange={setStatuses}
                    options={[
                      { value: "open", label: "Open" },
                      { value: "in_progress", label: "In progress" },
                      { value: "resolved", label: "Resolved" },
                      { value: "void", label: "Void" },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Warranty
                  </span>
                  <Segmented<WarrantyView>
                    ariaLabel="Warranty filter"
                    size="sm"
                    value={warrantyView}
                    onChange={setWarrantyView}
                    options={[
                      { value: "all", label: "All" },
                      { value: "warranty", label: "Warranty only" },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Category
                  </span>
                  <TextInput
                    aria-label="Category filter"
                    value={categoryInput}
                    onChange={(e) => setCategoryInput(e.target.value)}
                    placeholder="e.g. plumbing"
                    className="min-h-0 w-40 py-1.5"
                  />
                </div>
              </div>

              {ticketsQuery.isError ? (
                <Callout variant="danger">Failed to load tickets. Please refresh.</Callout>
              ) : ticketsQuery.isLoading ? (
                <div className="h-40 rounded-lg bg-muted animate-pulse" />
              ) : (
                <EnhancedDataTable
                  data={visibleTickets}
                  emptyMessage="No tickets yet — raise one to start this unit's history."
                  columns={[
                    {
                      key: "title",
                      label: "Title",
                      sortable: true,
                      sortValue: (t) => t.title,
                      render: (t) => (
                        <button
                          type="button"
                          onClick={() => setDrawer({ ticket: t })}
                          className="text-left font-medium text-[var(--text-primary)] hover:underline focus-visible:underline focus-visible:outline-none"
                        >
                          {t.title}
                        </button>
                      ),
                    },
                    {
                      key: "category",
                      label: "Category",
                      render: (t) =>
                        t.category ?? <span className="text-muted-foreground">—</span>,
                    },
                    {
                      key: "warranty",
                      label: "Warranty",
                      render: (t) =>
                        t.warrantyFlag ? (
                          <Badge variant="gold">Warranty</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        ),
                    },
                    {
                      key: "status",
                      label: "Status",
                      sortable: true,
                      sortValue: (t) => t.status,
                      render: (t) => (
                        <StatusPill tone={PHASE2_STATUS_TONES.ticket[t.status]}>
                          {STATUS_LABELS[t.status]}
                        </StatusPill>
                      ),
                    },
                    {
                      key: "historyCount",
                      label: "History",
                      sortable: true,
                      sortValue: (t) => t.historyCount,
                      render: (t) => t.historyCount,
                    },
                    {
                      key: "created",
                      label: "Created",
                      sortable: true,
                      sortValue: (t) => t.createdAt,
                      render: (t) => formatDate(t.createdAt),
                    },
                  ]}
                />
              )}
            </>
          ) : (
            <HistoryTimeline unitId={unitId} />
          )}
        </CardContent>
      </Card>

      <TicketDrawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        unitId={unitId}
        ticket={drawer?.ticket ?? null}
      />

      <QuickLogDialog
        open={quickLogOpen}
        onClose={() => setQuickLogOpen(false)}
        unitId={unitId}
      />
    </>
  );
}

// ─── History timeline — immutable log, STRICTLY ZERO edit/delete controls ────

function HistoryTimeline({ unitId }: { unitId: string }) {
  const historyQuery = useUnitHistory(unitId);
  const urlsQuery = useUnitHistoryAttachmentUrls(unitId);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Lightbox: Esc closes, body scroll locked while open.
  useEffect(() => {
    if (!lightboxUrl) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxUrl(null);
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [lightboxUrl]);

  if (historyQuery.isError) {
    return <Callout variant="danger">Failed to load history. Please refresh.</Callout>;
  }
  if (historyQuery.isLoading) {
    return <div className="h-40 rounded-lg bg-muted animate-pulse" />;
  }

  const rows = historyQuery.data?.data ?? [];
  if (rows.length === 0) {
    return <Callout variant="info">No history yet — resolve a ticket or add an entry.</Callout>;
  }

  const urlByKey = new Map<string, AttachmentUrl>(
    (urlsQuery.data?.data ?? []).map((e) => [e.key, e]),
  );

  return (
    <>
      <ol data-testid="history-timeline" className="space-y-3">
        {rows.map((h) => (
          <li
            key={h.id}
            className="rounded-lg border border-border/50 bg-background/40 px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-foreground">
                {formatDate(h.occurredOn)}
              </span>
              {h.actor && (
                <span className="text-xs text-muted-foreground">by {h.actor.fullName}</span>
              )}
              {h.ticket && (
                <span className="ml-auto flex items-center gap-1.5">
                  <Badge variant="outline">{h.ticket.title}</Badge>
                  <StatusPill tone={PHASE2_STATUS_TONES.ticket[h.ticket.status]}>
                    {STATUS_LABELS[h.ticket.status]}
                  </StatusPill>
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm text-foreground whitespace-pre-wrap">{h.entry}</p>
            {h.attachmentKeys.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {h.attachmentKeys.map((key) => {
                  const entry = urlByKey.get(key);
                  if (!entry) {
                    return (
                      <div key={key} className="h-14 w-14 rounded-md bg-muted/60 animate-pulse" />
                    );
                  }
                  if (entry.kind === "image") {
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-label="View image"
                        onClick={() => setLightboxUrl(entry.url)}
                        className="h-14 w-14 overflow-hidden rounded-md border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        <img
                          src={entry.thumbnail ?? entry.url}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                        />
                      </button>
                    );
                  }
                  return (
                    <a
                      key={key}
                      href={entry.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
                      aria-label={entry.kind === "video" ? "Open video" : "Open PDF"}
                    >
                      {entry.kind === "video" ? (
                        <Video className="h-3.5 w-3.5" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                      {entry.kind}
                    </a>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ol>

      {/* Hand-rolled lightbox (images only) */}
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxUrl(null);
            }}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          <div
            className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={lightboxUrl} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" />
          </div>
        </div>
      )}
    </>
  );
}
