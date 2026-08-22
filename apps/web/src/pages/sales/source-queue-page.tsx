import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  BodyCell,
  DataTable,
  EmptyRow,
  HeadCell,
  PageHeader,
  Row,
  StatusPill,
  Surface,
  TableHead,
  TableWrap,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoleGate } from "@/components/role-gate";
import { formatDate } from "@/components/format";
import {
  approveSalesSourceQueue,
  listSalesSourceQueue,
  needsAmendmentSalesSourceQueue,
  rejectSalesSourceQueue,
  type SalesSourceQueueRow,
} from "@/api/sales-source-queue";
import {
  approveRentalListing,
  listRentalSourceQueue,
  needsAmendmentRentalListing,
  rejectRentalListing,
  type RentalSourceQueueRow,
} from "@/api/inventory-source-queue";
import {
  approvePropertySubmission,
  listPropertySourceQueue,
  needsAmendmentPropertySubmission,
  rejectPropertySubmission,
  type PropertySourceQueueRow,
} from "@/api/property-source-queue";
import { listSalesProjects, type SalesProject } from "@/api/sales";
import { SourceQueueProjectsTab } from "./source-queue-projects-tab";
// EditUnitDialog removed from RentalQueueCard after the three-table refactor:
// the queue row is a UnitSubmission (not a Listing), so editing requires the
// submission resubmit flow rather than the Listing-edit dialog.

/**
 * Manager+ Source Queue (W3b).
 *
 * Two sub-tabs ("?tab=sales|rental") share a single page shell:
 *  - Sales Entries   — pending agent-sourced SalesUnits awaiting Manager sign-off.
 *  - Rental Units    — pending agent-sourced rental Units (mirrors the
 *                      legacy `agent-sourced-queue-page.tsx`, but extended
 *                      with Reject + Needs Amendment verbs).
 *
 * Each row exposes three verbs:
 *  - Approve         — confirmation, sets sourcingApproved=true.
 *  - Reject          — note required, FINAL (agent cannot resubmit).
 *  - Needs Amendment — note required, agent can amend + resubmit.
 *
 * The whole page is gated to manager+ on the client (RoleGate). The server
 * remains the source of truth — every endpoint calls `requireRole("manager")`.
 */

type TabKey = "sales" | "rental" | "properties" | "projects" | "pending";

type AgentLookup = {
  id: string;
  displayName: string;
  agentLevel: string | null;
};

type ActionKind = "reject" | "amend";

type NoteDialogState =
  | { open: false }
  | {
      open: true;
      kind: ActionKind;
      tab: TabKey;
      id: string;
      label: string;
    };

export default function SourceQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabKey =
    searchParams.get("tab") === "rental" ? "rental"
    : searchParams.get("tab") === "properties" ? "properties"
    : searchParams.get("tab") === "projects" ? "projects"
    : searchParams.get("tab") === "pending" ? "pending"
    : "sales";

  function setTab(next: TabKey) {
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  }

  const [toast, setToast] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);
  const [noteDialog, setNoteDialog] = useState<NoteDialogState>({ open: false });
  const [confirmApprove, setConfirmApprove] = useState<
    { tab: TabKey; id: string; label: string } | null
  >(null);

  return (
    <RoleGate
      min="manager"
      fallback={
        <div className="space-y-6">
          <PageHeader
            title="Source queue"
            description="Agent-submitted sales and rental listings awaiting Manager sign-off."
          />
          <Surface>
            <div className="py-10 text-center">
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Forbidden
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                The source queue is restricted to Manager and Admin roles.
              </p>
            </div>
          </Surface>
        </div>
      }
    >
      <div className="space-y-6">
        <PageHeader
          title="Source queue"
          description="Approve, reject, or request amendments on agent-sourced submissions before they go live."
        />

        {toast && (
          <div
            role="status"
            className={
              toast.kind === "success"
                ? "rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
            }
          >
            {toast.text}
          </div>
        )}

        <TabSwitcher tab={tab} onChange={setTab} />

        {tab === "sales" || tab === "pending" ? (
          <SalesQueueTab
            // Both "Sales Entries" and "Pending (incl. resubmitted)" tabs render
            // the same underlying query (sourcingApproved=false, AGENT_SOURCED).
            // The pending tab exists so admins understand that units resubmitted
            // after amendment (T6 fix: note cleared → back to pending) appear
            // here alongside first-time submissions.
            pendingView={tab === "pending"}
            onAskApprove={(id, label) =>
              setConfirmApprove({ tab: "sales", id, label })
            }
            onAskNote={(kind, id, label) =>
              setNoteDialog({ open: true, kind, tab: "sales", id, label })
            }
          />
        ) : tab === "rental" ? (
          <RentalQueueTab
            onAskApprove={(id, label) =>
              setConfirmApprove({ tab: "rental", id, label })
            }
            onAskNote={(kind, id, label) =>
              setNoteDialog({ open: true, kind, tab: "rental", id, label })
            }
          />
        ) : tab === "properties" ? (
          <PropertiesQueueTab
            onAskApprove={(id, label) =>
              setConfirmApprove({ tab: "properties", id, label })
            }
            onAskNote={(kind, id, label) =>
              setNoteDialog({ open: true, kind, tab: "properties", id, label })
            }
          />
        ) : (
          <SourceQueueProjectsTab />
        )}

        <ApproveConfirmDialog
          state={confirmApprove}
          onClose={() => setConfirmApprove(null)}
          setToast={setToast}
        />
        <NoteDialog
          state={noteDialog}
          onClose={() => setNoteDialog({ open: false })}
          setToast={setToast}
        />
      </div>
    </RoleGate>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tab switcher
// ────────────────────────────────────────────────────────────────────────────

function TabSwitcher({
  tab,
  onChange,
}: {
  tab: TabKey;
  onChange: (next: TabKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Source queue category"
      className="inline-flex rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
    >
      {(
        [
          { key: "sales", label: "Sales Entries" },
          { key: "rental", label: "Rental Units" },
          { key: "properties", label: "Properties" },
          { key: "projects", label: "Projects" },
          { key: "pending", label: "Pending (incl. resubmitted)" },
        ] as const
      ).map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={
              active
                ? "rounded-md bg-[var(--primary)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm"
                : "rounded-md px-4 py-1.5 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sales tab
// ────────────────────────────────────────────────────────────────────────────

function SalesQueueTab({
  pendingView = false,
  onAskApprove,
  onAskNote,
}: {
  /**
   * When true, the Surface header uses the "Pending (incl. resubmitted)"
   * framing so admins understand the tab includes units that were sent back
   * for amendment and then resubmitted by the agent. The underlying query
   * and filter are identical regardless of this flag.
   */
  pendingView?: boolean;
  onAskApprove: (id: string, label: string) => void;
  onAskNote: (kind: ActionKind, id: string, label: string) => void;
}) {
  const queue = useQuery({
    queryKey: ["sales", "source-queue"],
    queryFn: () => listSalesSourceQueue(),
    staleTime: 15_000,
  });

  // Project + agent name lookups for nicer row display. Failures are
  // non-fatal — we fall back to UUID fragments / em-dashes.
  const projects = useQuery({
    queryKey: ["sales", "projects"],
    queryFn: () => listSalesProjects(),
    staleTime: 60_000,
  });

  const agents = useQuery({
    queryKey: ["parties", "agents"],
    queryFn: () => apiFetch<{ data: AgentLookup[] }>("/parties/agents"),
    staleTime: 60_000,
  });

  const projectById = useMemo(() => {
    const map = new Map<string, SalesProject>();
    for (const p of projects.data?.data ?? []) map.set(p.id, p);
    return map;
  }, [projects.data]);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentLookup>();
    for (const a of agents.data?.data ?? []) map.set(a.id, a);
    return map;
  }, [agents.data]);

  // Server filter at /sales/source-queue is sourcingApproved=false. The
  // service endpoint returns every pending row in the org — we filter
  // client-side to AGENT_SOURCED in case any company-sourced rows ever
  // slip through. Cheap, safe, and matches the UX promise.
  const rows = (queue.data?.data ?? []).filter(
    (r) => r.sourceFlag === "AGENT_SOURCED",
  );

  const surfaceTitle = pendingView
    ? "Pending submissions (incl. resubmitted)"
    : "Pending sales entries";
  const surfaceDescription = pendingView
    ? "All agent-sourced SalesUnits awaiting sign-off — includes first-time submissions and units resubmitted after amendment."
    : "Agent-submitted SalesUnits awaiting Manager sign-off. Newest first.";

  return (
    <Surface
      title={surfaceTitle}
      description={surfaceDescription}
    >
      <QueueBody
        isLoading={queue.isLoading}
        hasError={queue.isError}
        emptyLabel="No agent-sourced sales entries are awaiting approval."
        colSpan={6}
        head={
          <tr>
            <HeadCell>Project</HeadCell>
            <HeadCell>Unit #</HeadCell>
            <HeadCell>Sourcing agent</HeadCell>
            <HeadCell>Sales date</HeadCell>
            <HeadCell>Submitted</HeadCell>
            <HeadCell className="text-right">Actions</HeadCell>
          </tr>
        }
      >
        {rows.map((row) => {
          const project = projectById.get(row.projectId);
          const agent = agentById.get(row.agentPartyId);
          const label = `${project?.name ?? "Unknown project"} · Unit ${row.unitNumber}`;
          return (
            <SalesQueueRow
              key={row.id}
              row={row}
              projectName={project?.name ?? null}
              projectCity={project?.city ?? null}
              agent={agent ?? null}
              onApprove={() => onAskApprove(row.id, label)}
              onReject={() => onAskNote("reject", row.id, label)}
              onAmend={() => onAskNote("amend", row.id, label)}
            />
          );
        })}
      </QueueBody>
    </Surface>
  );
}

function SalesQueueRow({
  row,
  projectName,
  projectCity,
  agent,
  onApprove,
  onReject,
  onAmend,
}: {
  row: SalesSourceQueueRow;
  projectName: string | null;
  projectCity: string | null;
  agent: AgentLookup | null;
  onApprove: () => void;
  onReject: () => void;
  onAmend: () => void;
}) {
  return (
    <Row>
      <BodyCell>
        <div className="flex flex-col">
          <span className="font-medium text-[var(--text-primary)]">
            {projectName ?? "Unknown project"}
          </span>
          {projectCity && (
            <span className="text-xs text-[var(--text-muted)]">{projectCity}</span>
          )}
          {row.amendmentNotes && (
            <span className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Amend: {row.amendmentNotes}
            </span>
          )}
        </div>
      </BodyCell>
      <BodyCell>
        <span className="font-mono text-xs text-[var(--text-primary)]">
          {row.unitNumber}
        </span>
      </BodyCell>
      <BodyCell>
        {agent ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-[var(--text-primary)]">
              {agent.displayName}
            </span>
            {agent.agentLevel && (
              <StatusPill tone="sky">{agent.agentLevel}</StatusPill>
            )}
          </div>
        ) : (
          <span className="font-mono text-xs text-[var(--text-muted)]">
            {row.agentPartyId.slice(0, 8)}…
          </span>
        )}
      </BodyCell>
      <BodyCell className="text-sm text-[var(--text-secondary)]">
        {formatDate(row.salesDate)}
      </BodyCell>
      <BodyCell className="text-sm text-[var(--text-secondary)]">
        {formatDate(row.createdAt)}
      </BodyCell>
      <BodyCell className="text-right">
        <div className="inline-flex items-center gap-2">
          <Button variant="default" size="sm" onClick={onApprove}>
            Approve
          </Button>
          <Button variant="outline" size="sm" onClick={onAmend}>
            Needs Amendment
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject}>
            Reject
          </Button>
        </div>
      </BodyCell>
    </Row>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Rental tab
// ────────────────────────────────────────────────────────────────────────────

function RentalQueueTab({
  onAskApprove,
  onAskNote,
}: {
  onAskApprove: (id: string, label: string) => void;
  onAskNote: (kind: ActionKind, id: string, label: string) => void;
}) {
  const queue = useQuery({
    queryKey: ["inventory", "source-queue"],
    queryFn: () => listRentalSourceQueue(),
    staleTime: 15_000,
  });

  const agents = useQuery({
    queryKey: ["parties", "agents"],
    queryFn: () => apiFetch<{ data: AgentLookup[] }>("/parties/agents"),
    staleTime: 60_000,
  });

  const agentById = useMemo(() => {
    const map = new Map<string, AgentLookup>();
    for (const a of agents.data?.data ?? []) map.set(a.id, a);
    return map;
  }, [agents.data]);

  const rows = queue.data?.data ?? [];

  return (
    <Surface
      title="Pending rental units"
      description="Agent-uploaded rental Units awaiting Manager sign-off before they go public."
    >
      {queue.isLoading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
      ) : queue.isError ? (
        <p className="p-6 text-sm text-rose-600">
          Failed to load queue. Please refresh.
        </p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-[var(--text-muted)]">
          No agent-sourced rental units are awaiting approval.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const agent = row.sourcingAgentId
              ? agentById.get(row.sourcingAgentId)
              : null;
            // After the three-table refactor, the row is a UnitSubmission;
            // propertyName isn't denormalised onto it anymore — it's nested
            // under row.property (or row.propertySubmission when the parent
            // building is itself still pending), so the action dialog can
            // disambiguate units with the same code across condos.
            const propertyName =
              row.property?.name ??
              row.propertySubmission?.proposedName ??
              null;
            const label = propertyName
              ? `${row.unitCode} · ${row.listingType} · ${propertyName}`
              : `${row.unitCode} · ${row.listingType}`;
            return (
              <RentalQueueCard
                key={row.id}
                row={row}
                agent={agent ?? null}
                onApprove={() => onAskApprove(row.id, label)}
                onReject={() => onAskNote("reject", row.id, label)}
                onAmend={() => onAskNote("amend", row.id, label)}
              />
            );
          })}
        </div>
      )}
    </Surface>
  );
}

function RentalQueueCard({
  row,
  agent,
  onApprove,
  onReject,
  onAmend,
}: {
  row: RentalSourceQueueRow;
  agent: AgentLookup | null;
  onApprove: () => void;
  onReject: () => void;
  onAmend: () => void;
}) {
  // Post three-table refactor: the queue row is a UnitSubmission. Most
  // commercial detail (rentalRate, deposits, parking) lives inside
  // `submittedPayload.listing`; apartment-shared fields live inside
  // `submittedPayload.apartmentShared`. Render a slim header card —
  // detailed diff/preview UX is TODO follow-up.
  const payload = (row.submittedPayload ?? {}) as {
    listing?: Record<string, unknown>;
    apartmentShared?: Record<string, unknown>;
  };
  const listingPayload = payload.listing ?? {};
  const sharedPayload = payload.apartmentShared ?? {};
  const rentalRate = typeof listingPayload.rentalRate === "number"
    ? listingPayload.rentalRate
    : null;
  const bedrooms = typeof sharedPayload.bedrooms === "number"
    ? sharedPayload.bedrooms
    : null;
  const isAmendment = row.parentListingId !== null;

  // Property label: prefer the approved Property (name + code); fall back to
  // the still-pending PropertySubmission so admin can match an agent's draft
  // unit to its draft building. Tagged as "(pending property)" so the admin
  // knows they need to approve the parent first.
  const propertyLabel = row.property
    ? `${row.property.name} (${row.property.propertyCode})`
    : row.propertySubmission
      ? `${row.propertySubmission.proposedName} (${row.propertySubmission.propertyCode}) — pending property`
      : null;

  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          {/* Header — submission state + amendment marker + listingType */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-[var(--text-secondary)]">
              {row.unitCode}
            </span>
            <StatusPill tone="amber">{row.listingType}</StatusPill>
            {isAmendment ? (
              <StatusPill tone="sky">Amendment to existing</StatusPill>
            ) : (
              <StatusPill tone="emerald">New listing</StatusPill>
            )}
            {row.submissionState === "needs_amendment" && (
              <StatusPill tone="amber">Needs amendment</StatusPill>
            )}
          </div>

          {propertyLabel && (
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                Property
              </div>
              <div className="text-sm font-medium text-[var(--text-primary)]">
                {propertyLabel}
              </div>
            </div>
          )}

          {/* Submitter + meta */}
          <div className="grid gap-3 text-xs text-[var(--text-secondary)] sm:grid-cols-3">
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                Submitted by
              </div>
              <div className="text-sm text-[var(--text-primary)]">
                {agent?.displayName ?? "(unknown)"}
              </div>
              {agent?.agentLevel && (
                <StatusPill tone="sky">{agent.agentLevel}</StatusPill>
              )}
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                Submitted
              </div>
              <div className="text-sm text-[var(--text-primary)]">
                {formatDate(row.createdAt)}
              </div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                Rent (RM/month)
              </div>
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {rentalRate != null
                  ? `RM ${Number(rentalRate).toLocaleString()}/month`
                  : "—"}
              </div>
            </div>
          </div>

          {/* Apartment-shared snapshot from submittedPayload.apartmentShared.
              Only renders fields present in the payload. */}
          <div className="grid gap-3 text-xs text-[var(--text-secondary)] sm:grid-cols-3">
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                Bedrooms
              </div>
              <div className="text-sm text-[var(--text-primary)]">
                {bedrooms ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                Listing mode
              </div>
              <div className="text-sm text-[var(--text-primary)]">
                {row.listingMode}
              </div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wide">
                State
              </div>
              <div className="text-sm text-[var(--text-primary)]">
                {row.submissionState}
              </div>
            </div>
          </div>

          {row.amendmentNote && (() => {
            // Reject notes are prefixed with "REJECTED:" by the API service
            // for back-compat with My Uploads bucketing. Strip the prefix
            // when present.
            const isReject = row.amendmentNote.startsWith("REJECTED:");
            const labelText = isReject ? "Prior reject note:" : "Prior amendment note:";
            const noteBody = isReject
              ? row.amendmentNote.replace(/^REJECTED:\s*/, "")
              : row.amendmentNote;
            return (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs italic text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
                <span className="font-semibold not-italic">{labelText}</span>{" "}
                {noteBody}
              </div>
            );
          })()}
        </div>

        {/* Actions — the underlying endpoints
            (/source-queue/unit-submissions/:id/approve|reject|needs-amendment)
            are wired in a later C-series follow-up; the buttons will surface
            a 404 toast until then. */}
        <div className="flex shrink-0 flex-col gap-2">
          <Button variant="default" size="sm" onClick={onApprove}>
            Approve
          </Button>
          <Button variant="outline" size="sm" onClick={onAmend}>
            Needs Amendment
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject}>
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Shared queue body
// ────────────────────────────────────────────────────────────────────────────

function QueueBody({
  isLoading,
  hasError,
  emptyLabel,
  colSpan,
  head,
  children,
}: {
  isLoading: boolean;
  hasError: boolean;
  emptyLabel: string;
  colSpan: number;
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }
  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load queue. Please refresh.
      </p>
    );
  }
  // children is the rows array; if empty, show <EmptyRow />.
  const empty = !children || (Array.isArray(children) && children.length === 0);
  return (
    <TableWrap>
      <DataTable>
        <TableHead>{head}</TableHead>
        <tbody>
          {empty ? <EmptyRow colSpan={colSpan} label={emptyLabel} /> : children}
        </tbody>
      </DataTable>
    </TableWrap>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Properties tab — pending PropertySubmissions
// ────────────────────────────────────────────────────────────────────────────

function PropertiesQueueTab({
  onAskApprove,
  onAskNote,
}: {
  onAskApprove: (id: string, label: string) => void;
  onAskNote: (kind: ActionKind, id: string, label: string) => void;
}) {
  const queue = useQuery({
    queryKey: ["property-source-queue"],
    queryFn: () => listPropertySourceQueue(),
    staleTime: 15_000,
  });

  const agents = useQuery({
    queryKey: ["parties", "agents"],
    queryFn: () => apiFetch<{ data: AgentLookup[] }>("/parties/agents"),
    staleTime: 60_000,
  });

  const agentById = useMemo(() => {
    const map = new Map<string, AgentLookup>();
    for (const a of agents.data?.data ?? []) map.set(a.id, a);
    return map;
  }, [agents.data]);

  const rows = queue.data?.data ?? [];

  return (
    <Surface
      title="Pending properties"
      description="Agent-created properties awaiting Manager sign-off before agents can attach units."
    >
      {queue.isLoading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
        </div>
      ) : queue.isError ? (
        <p className="p-6 text-sm text-rose-600">
          Failed to load queue. Please refresh.
        </p>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-[var(--text-muted)]">
          No agent-sourced properties are awaiting approval.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row: PropertySourceQueueRow) => {
            const agent = row.sourcingAgentId
              ? agentById.get(row.sourcingAgentId)
              : null;
            const label = `${row.propertyCode} · ${row.proposedName}`;
            return (
              <div
                key={row.id}
                className="rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-[var(--text-secondary)]">
                        {row.propertyCode}
                      </span>
                      <span className="font-semibold text-[var(--text-primary)]">
                        {row.proposedName}
                      </span>
                      <StatusPill tone="amber">{row.propertyType}</StatusPill>
                      {row.submissionState === "needs_amendment" && (
                        <StatusPill tone="amber">Needs amendment</StatusPill>
                      )}
                    </div>
                    <div className="grid gap-3 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
                      <div>
                        <div className="text-[var(--text-muted)] uppercase tracking-wide">
                          Submitted by
                        </div>
                        <div>{agent?.displayName ?? "Unknown agent"}</div>
                      </div>
                      <div>
                        <div className="text-[var(--text-muted)] uppercase tracking-wide">
                          Submitted
                        </div>
                        <div>{formatDate(row.createdAt)}</div>
                      </div>
                    </div>
                    {row.amendmentNote && (
                      <p className="text-xs text-[var(--text-muted)] italic">
                        Prior admin note: {row.amendmentNote}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onAskApprove(row.id, label)}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onAskNote("amend", row.id, label)}
                    >
                      Request amendment
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onAskNote("reject", row.id, label)}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Surface>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Approve confirmation dialog
// ────────────────────────────────────────────────────────────────────────────

function ApproveConfirmDialog({
  state,
  onClose,
  setToast,
}: {
  state: { tab: TabKey; id: string; label: string } | null;
  onClose: () => void;
  setToast: (t: { kind: "success" | "error"; text: string } | null) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: { tab: TabKey; id: string }) => {
      if (input.tab === "sales") {
        return approveSalesSourceQueue(input.id);
      }
      if (input.tab === "properties") {
        return approvePropertySubmission(input.id);
      }
      return approveRentalListing(input.id);
    },
    onSuccess: (_data, vars) => {
      setToast({
        kind: "success",
        text:
          vars.tab === "sales"
            ? "Sales entry approved."
            : vars.tab === "properties"
              ? "Property approved."
              : "Rental listing approved.",
      });
      invalidateQueues(queryClient, vars.tab);
      onClose();
    },
    onError: (err: Error) =>
      setToast({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Approve failed.",
      }),
  });

  const open = !!state;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve submission</DialogTitle>
          <DialogDescription>
            {state ? state.label : ""} — this marks the row as approved and
            removes it from the queue.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="default"
            disabled={mutation.isPending || !state}
            onClick={() => state && mutation.mutate({ tab: state.tab, id: state.id })}
          >
            {mutation.isPending ? "Approving…" : "Approve"}
          </Button>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Reject / Needs-Amendment note dialog
// ────────────────────────────────────────────────────────────────────────────

function NoteDialog({
  state,
  onClose,
  setToast,
}: {
  state: NoteDialogState;
  onClose: () => void;
  setToast: (t: { kind: "success" | "error"; text: string } | null) => void;
}) {
  // Form lives in a child component keyed on the target so React
  // remounts it (and resets `note`) whenever the dialog opens against
  // a different row — avoids a setState-in-effect lint error.
  const formKey = state.open ? `${state.tab}:${state.id}:${state.kind}` : "closed";
  return (
    <Dialog
      open={state.open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        {state.open ? (
          <NoteDialogForm
            key={formKey}
            state={state}
            onClose={onClose}
            setToast={setToast}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NoteDialogForm({
  state,
  onClose,
  setToast,
}: {
  state: Extract<NoteDialogState, { open: true }>;
  onClose: () => void;
  setToast: (t: { kind: "success" | "error"; text: string } | null) => void;
}) {
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: {
      tab: TabKey;
      id: string;
      kind: ActionKind;
      note: string;
    }) => {
      if (input.tab === "sales") {
        return input.kind === "reject"
          ? rejectSalesSourceQueue(input.id, input.note)
          : needsAmendmentSalesSourceQueue(input.id, input.note);
      }
      if (input.tab === "properties") {
        return input.kind === "reject"
          ? rejectPropertySubmission(input.id, input.note)
          : needsAmendmentPropertySubmission(input.id, input.note);
      }
      return input.kind === "reject"
        ? rejectRentalListing(input.id, input.note)
        : needsAmendmentRentalListing(input.id, input.note);
    },
    onSuccess: (_data, vars) => {
      setToast({
        kind: "success",
        text:
          vars.kind === "reject"
            ? "Submission rejected."
            : "Amendment requested.",
      });
      invalidateQueues(queryClient, vars.tab);
      onClose();
    },
    onError: (err: Error) =>
      setToast({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Action failed.",
      }),
  });

  const trimmed = note.trim();
  const canSubmit = trimmed.length > 0 && !mutation.isPending;

  const isReject = state.kind === "reject";
  const title = isReject ? "Reject submission" : "Request amendment";
  const description = isReject
    ? "Rejecting is final — the agent cannot resubmit. Provide a reason for the audit log."
    : "The agent will be able to amend and resubmit. Explain what needs to change.";
  const submitLabel = isReject ? "Reject" : "Send for amendment";
  const submitVariant: "destructive" | "default" = isReject
    ? "destructive"
    : "default";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {state.label} — {description}
        </DialogDescription>
      </DialogHeader>
      <div>
        <label
          htmlFor="source-queue-note"
          className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]"
        >
          Note
        </label>
        <textarea
          id="source-queue-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder="Explain the reason — visible to the submitting agent and the audit log."
          className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {trimmed.length}/500
        </p>
      </div>
      <DialogFooter>
        <Button
          variant={submitVariant}
          disabled={!canSubmit}
          onClick={() =>
            mutation.mutate({
              tab: state.tab,
              id: state.id,
              kind: state.kind,
              note: trimmed,
            })
          }
        >
          {mutation.isPending ? "Submitting…" : submitLabel}
        </Button>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function invalidateQueues(
  queryClient: ReturnType<typeof useQueryClient>,
  tab: TabKey,
) {
  if (tab === "sales") {
    queryClient.invalidateQueries({ queryKey: ["sales", "source-queue"] });
    // Refresh `useSalesUnits` consumers too — approval flips sourcingApproved.
    queryClient.invalidateQueries({ queryKey: ["sales", "units"] });
  } else if (tab === "properties") {
    queryClient.invalidateQueries({ queryKey: ["property-source-queue"] });
    // Properties feed several pages — refresh broadly.
    queryClient.invalidateQueries({ queryKey: ["properties"] });
    queryClient.invalidateQueries({ queryKey: ["inventory", "source-queue"] });
  } else {
    queryClient.invalidateQueries({ queryKey: ["inventory", "source-queue"] });
    queryClient.invalidateQueries({ queryKey: ["listings"] });
  }
}

