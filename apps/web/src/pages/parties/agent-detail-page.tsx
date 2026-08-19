import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { useAgentDetail } from "./use-agent-detail";
import { StatusPill } from "@/components/ui";
import { formatDate, formatMoney } from "@/components/format";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  MoreHorizontalIcon,
  ShieldOffIcon,
  CircleCheckIcon,
  CircleXIcon,
} from "lucide-react";
import { ClaimsTableNavigable } from "../commissions/claims-table";
import type { ClaimListItem } from "../commissions/claims-table";
import { AgentFormDrawer } from "./agent-form-drawer";
import { AgentBlacklistDrawer } from "./agent-blacklist-drawer";
import { AgentPortalAccessDrawer } from "./agent-portal-access-drawer";
import { ResetPortalPasswordDrawer } from "./reset-portal-password-drawer";
import { AgentCardSection } from "./agent-card-section";
import type { AgentDetail } from "./use-agent-detail";
import type { AgentListItem } from "./agents-table";
import { INDIVIDUAL_ID_TYPES, NATIONALITIES, labelOf } from "@/lib/malaysia-refdata";
import { RoleGate } from "@/components/role-gate";

// ── Types ────────────────────────────────────────────────────────────────────

type ClaimsResponse = {
  data: ClaimListItem[];
  pagination: { page: number; limit: number; total: number };
};

// ── Helper: project AgentDetail fields the drawers need into AgentListItem ────

function agentDetailToListItem(d: AgentDetail): AgentListItem {
  return {
    id: d.id,
    displayName: d.displayName,
    legalName: d.legalName,
    primaryEmail: d.primaryEmail,
    primaryPhone: d.primaryPhone,
    formattedPhone: d.formattedPhone,
    nationality: d.nationality,
    agentLevel: d.agentLevel,
    status: d.status,
    isBlacklisted: d.isBlacklisted,
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
    bankName: d.bank.name,
    bankAccountHolder: d.bank.accountHolder,
    bankAccountNumber: d.bank.accountNumber,
    idType: d.idType,
    idNumber: d.idNumber,
    portalUser: d.portalUser
      ? {
          id: d.portalUser.id,
          email: d.portalUser.email,
          status: d.portalUser.status,
          updatedAt: d.portalUser.updatedAt,
        }
      : null,
    photoUrl: null,
  };
}

// ── Drawer state ─────────────────────────────────────────────────────────────

type DrawerState =
  | { kind: "form"; mode: "create" | "edit"; agent: AgentListItem | null }
  | { kind: "blacklist"; mode: "blacklist" | "reactivate"; agent: AgentListItem }
  | { kind: "portal"; mode: "grant" | "revoke"; agent: AgentListItem }
  | { kind: "resetPortalPassword"; agent: AgentListItem }
  | null;

// ── Constants ────────────────────────────────────────────────────────────────

const AGENT_LEVEL_LABELS: Record<string, string> = {
  new_agent: "New Agent",
  pre_leader: "Pre Leader",
  leader: "Leader",
};

// ── Card wrapper (glassmorphism) ──────────────────────────────────────────────

function GlassCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

function CardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <GlassCard>
      <div className="border-b border-[var(--card-border)] px-5 py-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </GlassCard>
  );
}

function LabelValue({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm text-[var(--text-primary)]">{value ?? "—"}</p>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{value}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [page, setPage] = useState(1);

  const detail = useAgentDetail(id);

  const claims = useQuery({
    queryKey: ["commissions", "claims", { agentPartyId: id, page, limit: 20 }],
    queryFn: () =>
      apiFetch<ClaimsResponse>(
        `/commissions/claims?agentPartyId=${id}&page=${page}&limit=20`,
      ),
    enabled: !!id,
  });

  // After any mutation succeeds, invalidate both the detail query and the agents list
  function invalidateBoth() {
    queryClient.invalidateQueries({ queryKey: ["parties", "agents", id] });
    queryClient.invalidateQueries({ queryKey: ["agents"] });
  }

  function closeDrawer() {
    setDrawer(null);
    // Refetch detail so the page reflects changes
    invalidateBoth();
  }

  // ── Loading / error ──────────────────────────────────────────────────────

  if (detail.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-24 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-48 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load agent. Please refresh.
      </p>
    );
  }

  const agent = detail.data;
  const listItem = agentDetailToListItem(agent);

  const claimList = claims.data?.data ?? [];
  const pagination = claims.data?.pagination;
  const totalPages = pagination ? Math.ceil(pagination.total / pagination.limit) : 1;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <GlassCard>
        <div className="px-5 py-4">
          <button
            type="button"
            onClick={() => navigate("/parties/agents")}
            className="mb-3 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition flex items-center gap-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Agents
          </button>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-[var(--text-primary)]">
                {agent.displayName}
              </h1>
              <StatusPill tone={agent.isBlacklisted ? "rose" : "emerald"}>
                <span className="inline-flex items-center gap-1">
                  {agent.isBlacklisted ? (
                    <ShieldOffIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  ) : agent.status === "active" ? (
                    <CircleCheckIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <CircleXIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {agent.isBlacklisted ? "blacklisted" : agent.status}
                </span>
              </StatusPill>
            </div>

            {/* ⋯ menu — all items are destructive/mutation, so gate the whole menu. */}
            <RoleGate min="manager">
              <div className="flex items-center gap-2">
                {agent.portalUser && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDrawer({ kind: "resetPortalPassword", agent: listItem })}
                  >
                    Reset portal password
                  </Button>
                )}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`Actions for ${agent.displayName}`}
                  className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                >
                  <MoreHorizontalIcon className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!agent.isBlacklisted && (
                    <DropdownMenuItem onClick={() => setDrawer({ kind: "form", mode: "edit", agent: listItem })}>
                      Edit
                    </DropdownMenuItem>
                  )}

                  {!agent.isBlacklisted && !agent.portalUser && (
                    <DropdownMenuItem onClick={() => setDrawer({ kind: "portal", mode: "grant", agent: listItem })}>
                      Grant portal access
                    </DropdownMenuItem>
                  )}

                  {!agent.isBlacklisted && agent.portalUser && (
                    <DropdownMenuItem onClick={() => setDrawer({ kind: "portal", mode: "revoke", agent: listItem })}>
                      Revoke portal access
                    </DropdownMenuItem>
                  )}

                  {agent.isBlacklisted && (
                    <DropdownMenuItem onClick={() => setDrawer({ kind: "blacklist", mode: "reactivate", agent: listItem })}>
                      Reactivate
                    </DropdownMenuItem>
                  )}

                  {!agent.isBlacklisted && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setDrawer({ kind: "blacklist", mode: "blacklist", agent: listItem })}
                        className="text-rose-600 data-highlighted:bg-rose-500/10 data-highlighted:text-rose-700"
                      >
                        Blacklist
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              </div>
            </RoleGate>
          </div>
        </div>
      </GlassCard>

      {/* ── Profile card ────────────────────────────────────────────────── */}
      <CardSection title="Profile">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <LabelValue label="Legal name" value={agent.legalName} />
          <LabelValue label="Email" value={agent.primaryEmail} />
          <LabelValue label="Phone" value={agent.formattedPhone ?? agent.primaryPhone} />
          <LabelValue
            label="ID"
            value={(() => {
              const idLabel = labelOf(INDIVIDUAL_ID_TYPES, agent.idType);
              if (idLabel && agent.idNumber) return `${idLabel} · ${agent.idNumber}`;
              return idLabel || agent.idNumber;
            })()}
          />
          <LabelValue label="Nationality" value={labelOf(NATIONALITIES, agent.nationality) || agent.nationality} />
          <LabelValue
            label="Agent level"
            value={agent.agentLevel ? (AGENT_LEVEL_LABELS[agent.agentLevel] ?? agent.agentLevel) : null}
          />
        </div>

        {/* Bank block */}
        {(agent.bank.name || agent.bank.accountHolder || agent.bank.accountNumber) && (
          <div className="mt-4 rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">Bank details</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <LabelValue label="Bank" value={agent.bank.name} />
              <LabelValue label="Account holder" value={agent.bank.accountHolder} />
              <LabelValue label="Account number" value={agent.bank.accountNumber} />
            </div>
          </div>
        )}

        {agent.isBlacklisted && agent.blacklistReason && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/40">
            <p className="text-xs font-semibold text-rose-700 dark:text-rose-400 mb-1">Blacklist reason</p>
            <p className="text-sm text-rose-700 dark:text-rose-300">{agent.blacklistReason}</p>
          </div>
        )}
      </CardSection>

      {/* ── E-Namecard ──────────────────────────────────────────────────
          Sits between Profile and Claims so the prominent visual artifact
          appears above the long claims tables but below the agent's
          identity. `agent.id` is the partyId — the parties table is the
          agents table in this codebase (see use-agent-detail.ts). The
          agent-detail API does NOT return whatsappPhone today; the card
          preview displays primaryPhone visually regardless, and the
          WhatsApp tap-action only matters on the public page. */}
      <AgentCardSection partyId={agent.id} />

      {/* ── Claims summary — gated; editors don't get claimStats from the API */}
      {/* Mobile: accordion for cards 3–5 */}

      {agent.claimStats && (
        <>
          {/* Card 3 — Claims summary */}
          <details className="md:hidden rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm">
            <summary className="px-5 py-3 text-sm font-semibold text-[var(--text-primary)] cursor-pointer">
              Claims summary
            </summary>
            <div className="border-t border-[var(--card-border)] px-5 py-4">
              <ClaimsSummaryContent stats={agent.claimStats} />
            </div>
          </details>

          <div className="hidden md:block">
            <CardSection title="Claims summary">
              <ClaimsSummaryContent stats={agent.claimStats} />
            </CardSection>
          </div>
        </>
      )}

      {/* Card 4 — Claims history */}
      <details className="md:hidden rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm">
        <summary className="px-5 py-3 text-sm font-semibold text-[var(--text-primary)] cursor-pointer">
          Claims history
        </summary>
        <div className="border-t border-[var(--card-border)] px-5 py-4">
          <ClaimsHistoryContent
            claims={claimList}
            isLoading={claims.isLoading}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </div>
      </details>

      <div className="hidden md:block">
        <CardSection title="Claims history">
          <ClaimsHistoryContent
            claims={claimList}
            isLoading={claims.isLoading}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </CardSection>
      </div>

      {/* Card 5 — Portal access */}
      <details className="md:hidden rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] shadow-sm">
        <summary className="px-5 py-3 text-sm font-semibold text-[var(--text-primary)] cursor-pointer">
          Portal access
        </summary>
        <div className="border-t border-[var(--card-border)] px-5 py-4">
          <PortalAccessContent
            agent={agent}
            listItem={listItem}
            onOpenDrawer={setDrawer}
          />
        </div>
      </details>

      <div className="hidden md:block">
        <CardSection title="Portal access">
          <PortalAccessContent
            agent={agent}
            listItem={listItem}
            onOpenDrawer={setDrawer}
          />
        </CardSection>
      </div>

      {/* ── Drawers ──────────────────────────────────────────────────────── */}

      <AgentFormDrawer
        open={drawer?.kind === "form"}
        mode={drawer?.kind === "form" ? drawer.mode : "edit"}
        agent={drawer?.kind === "form" ? drawer.agent : null}
        onClose={closeDrawer}
        onResetPassword={
          drawer?.kind === "form" && drawer.mode === "edit" && drawer.agent
            ? () => setDrawer({ kind: "resetPortalPassword", agent: drawer.agent as AgentListItem })
            : undefined
        }
      />

      {drawer?.kind === "blacklist" && (
        <AgentBlacklistDrawer
          open
          mode={drawer.mode}
          agent={drawer.agent}
          onClose={closeDrawer}
        />
      )}

      {drawer?.kind === "portal" && (
        <AgentPortalAccessDrawer
          open
          mode={drawer.mode}
          agent={drawer.agent}
          onClose={closeDrawer}
        />
      )}

      {drawer?.kind === "resetPortalPassword" && (
        <ResetPortalPasswordDrawer
          open
          agent={drawer.agent}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ClaimsSummaryContent({
  stats,
}: {
  stats: NonNullable<AgentDetail["claimStats"]>;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatBlock label="Submitted" value={stats.submitted} />
        <StatBlock label="Approved" value={stats.approved} />
        <StatBlock label="Paid" value={stats.paid} />
        <StatBlock label="Rejected (incl. blacklist-auto)" value={stats.rejected} />
      </div>
      <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Total paid commission
        </p>
        <p className="mt-1 text-2xl font-bold text-[var(--text-primary)]">
          {formatMoney(stats.totalPaidCommission, "MYR")}
        </p>
      </div>
    </div>
  );
}

function ClaimsHistoryContent({
  claims,
  isLoading,
  page,
  totalPages,
  onPageChange,
}: {
  claims: ClaimListItem[];
  isLoading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-8 rounded bg-[var(--card-border)]" />
        <div className="h-8 rounded bg-[var(--card-border)]" />
        <div className="h-8 rounded bg-[var(--card-border)]" />
      </div>
    );
  }

  return (
    <div className="space-y-3 overflow-x-auto">
      <ClaimsTableNavigable claims={claims} embedded />
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Prev
          </Button>
          <span className="text-sm text-[var(--text-muted)]">
            {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function PortalAccessContent({
  agent,
  listItem,
  onOpenDrawer,
}: {
  agent: AgentDetail;
  listItem: AgentListItem;
  onOpenDrawer: (s: DrawerState) => void;
}) {
  const portal = agent.portalUser;

  if (!portal) {
    return (
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-[var(--text-primary)] font-medium">Not granted</p>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            No portal account has been created for this agent.
          </p>
        </div>
        {!agent.isBlacklisted && (
          <RoleGate min="manager">
            <Button
              variant="gold"
              size="sm"
              onClick={() => onOpenDrawer({ kind: "portal", mode: "grant", agent: listItem })}
            >
              Grant portal access
            </Button>
          </RoleGate>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid gap-2 sm:grid-cols-3 flex-1">
        <LabelValue label="Email" value={portal.email} />
        <LabelValue
          label="Status"
          value={portal.status}
        />
        <LabelValue
          label="Last login"
          value={portal.lastLoginAt ? formatDate(portal.lastLoginAt) : "Never"}
        />
      </div>
      <RoleGate min="manager">
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={() => onOpenDrawer({ kind: "portal", mode: "revoke", agent: listItem })}
        >
          Revoke portal access
        </Button>
      </RoleGate>
    </div>
  );
}
