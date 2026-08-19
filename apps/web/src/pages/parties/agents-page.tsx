import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { AgentTable } from "./agents-table";
import { AgentFormDrawer } from "./agent-form-drawer";
import { AgentBlacklistDrawer } from "./agent-blacklist-drawer";
import { AgentPortalAccessDrawer } from "./agent-portal-access-drawer";
import { ResetPortalPasswordDrawer } from "./reset-portal-password-drawer";
import { AgentsAreaTabs } from "./agents-area-tabs";
import { TeamAreaTabs } from "@/pages/organization/team-area-tabs";
import type { AgentListItem } from "./agents-table";

// ── Inline debounce hook ───────────────────────────────────────────────────
function useDebounced<T>(value: T, ms: number): T {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dv;
}

// ── LeaderTypeahead ────────────────────────────────────────────────────────
type SlimAgent = { id: string; displayName: string; agentLevel: string | null; status: string };

type LeaderTypeaheadProps = {
  value: string | null;
  displayName: string;
  onChange: (id: string | null, name: string) => void;
};

function LeaderTypeahead({ value, displayName, onChange }: LeaderTypeaheadProps) {
  const [q, setQ] = useState(displayName);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 300);

  const results = useQuery({
    queryKey: ["agent-typeahead-leader", debouncedQ],
    queryFn: () =>
      apiFetch<{ data: SlimAgent[] }>(
        `/parties/agents?q=${encodeURIComponent(debouncedQ)}`
      ),
    enabled: debouncedQ.length >= 2,
    staleTime: 30_000,
  });

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = results.data?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={value ? displayName : q}
          readOnly={!!value}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => { if (!value) setOpen(true); }}
          placeholder="Filter by team leader…"
          className="h-8 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] w-52"
        />
        {value && (
          <button
            type="button"
            onClick={() => { onChange(null, ""); setQ(""); }}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        )}
      </div>
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 w-52 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg py-1">
          {options.map((o) => (
            <li
              key={o.id}
              onMouseDown={() => {
                onChange(o.id, o.displayName);
                setQ(o.displayName);
                setOpen(false);
              }}
              className="cursor-pointer px-3 py-1.5 text-xs hover:bg-[var(--muted)] text-[var(--text-primary)]"
            >
              {o.displayName}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type DrawerState =
  | { kind: "form"; mode: "create" | "edit"; agent: AgentListItem | null }
  | { kind: "blacklist"; mode: "blacklist" | "reactivate" | "deactivate" | "activate"; agent: AgentListItem }
  | { kind: "portal"; mode: "grant" | "revoke"; agent: AgentListItem }
  | { kind: "resetPortalPassword"; agent: AgentListItem }
  | null;

type StatusFilter = "active" | "inactive" | "blacklisted" | "all";

export default function AgentsPage() {
  const navigate = useNavigate();

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [teamLeaderId, setTeamLeaderId] = useState<string | null>(null);
  const [teamLeaderName, setTeamLeaderName] = useState<string>("");
  const [teamScope, setTeamScope] = useState<"direct" | "indirect">("direct");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  // The Agents registry shows every agent regardless of level. Previously we
  // applied `excludeLevel=leader` so leader-tier agents surfaced only on a
  // separate page, but that hid newly created leader-level agents from the page
  // that just created them — operators read it as "create failed". Here,
  // sort/filter on the Agent Level column to scope the view. (Note: operator
  // "managers" — the User role — live under Team → Staff, a different entity.)
  const agents = useQuery({
    queryKey: ["agents", teamLeaderId, teamScope, "all-levels"],
    queryFn: () => {
      const params = new URLSearchParams();
      if (teamLeaderId) {
        params.set("teamLeaderId", teamLeaderId);
        params.set("teamScope", teamScope);
      }
      const qs = params.toString();
      return apiFetch<{ data: AgentListItem[] }>(
        qs ? `/parties/agents?${qs}` : "/parties/agents",
      );
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const allAgents = agents.data?.data ?? [];
  const blacklistedCount = allAgents.filter((a) => a.isBlacklisted).length;
  const inactiveCount = allAgents.filter((a) => a.status === "inactive" && !a.isBlacklisted).length;
  const agentList = allAgents.filter((a) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "blacklisted") return a.isBlacklisted;
    if (statusFilter === "inactive") return a.status === "inactive" && !a.isBlacklisted;
    return a.status === "active" && !a.isBlacklisted;
  });

  function closeDrawer() {
    setDrawer(null);
  }

  return (
    <div className="space-y-6">
      <TeamAreaTabs activeTab="agents" />
      <PageHeader
        title="Agent registry"
        description="Agent records are the control surface for identity, bank details, and blacklist governance."
        metrics={[
          { label: "Agents", value: String(allAgents.length), hint: "Total agent profiles" },
          {
            label: "Active",
            value: String(allAgents.filter((a) => a.status === "active" && !a.isBlacklisted).length),
            hint: "Profiles currently usable",
          },
          { label: "Inactive", value: String(inactiveCount), hint: "Soft-deactivated agents" },
          { label: "Blacklisted", value: String(blacklistedCount), hint: "Restricted agents" },
        ]}
        actions={
          <Button
            variant="gold"
            disabled={drawer !== null}
            onClick={() => setDrawer({ kind: "form", mode: "create", agent: null })}
          >
            + New Agent
          </Button>
        }
      />

      {/* Agent-area sub-tabs (Agents · Card Settings · Card Approvals) sit under
          the Team strip as the secondary navigation level for this surface. */}
      <AgentsAreaTabs activeTab="agents" />

      <Surface
        title="Agent records"
        description="Individual contributors only. See Team → Hierarchy for the full reporting tree."
      >
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="flex rounded-md border border-[var(--card-border)] overflow-hidden text-xs">
            {(["active", "inactive", "blacklisted", "all"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`px-3 py-1.5 capitalize border-l border-[var(--card-border)] first:border-l-0 ${statusFilter === s ? "bg-[var(--muted)] font-medium" : ""}`}
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <LeaderTypeahead
            value={teamLeaderId}
            displayName={teamLeaderName}
            onChange={(id, name) => {
              setTeamLeaderId(id);
              setTeamLeaderName(name);
              if (!id) setTeamScope("direct");
            }}
          />
          {teamLeaderId && (
            <div className="flex rounded-md border border-[var(--card-border)] overflow-hidden text-xs">
              <button
                type="button"
                className={`px-3 py-1.5 ${teamScope === "direct" ? "bg-[var(--muted)] font-medium" : ""}`}
                onClick={() => setTeamScope("direct")}
              >
                Direct only
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 border-l border-[var(--card-border)] ${teamScope === "indirect" ? "bg-[var(--muted)] font-medium" : ""}`}
                onClick={() => setTeamScope("indirect")}
              >
                Include indirect
              </button>
            </div>
          )}
        </div>
        {agents.isLoading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
            <div className="h-10 rounded bg-[var(--card-bg)] border border-[var(--card-border)]" />
          </div>
        ) : agents.isError ? (
          <p className="p-6 text-sm text-rose-600">Failed to load agents. Please refresh.</p>
        ) : (
          <AgentTable
            agents={agentList}
            onEdit={(agent) => setDrawer({ kind: "form", mode: "edit", agent })}
            onBlacklist={(agent) => setDrawer({ kind: "blacklist", mode: "blacklist", agent })}
            onReactivate={(agent) => setDrawer({ kind: "blacklist", mode: "reactivate", agent })}
            onDeactivate={(agent) => setDrawer({ kind: "blacklist", mode: "deactivate", agent })}
            onActivate={(agent) => setDrawer({ kind: "blacklist", mode: "activate", agent })}
            onGrantPortal={(agent) => setDrawer({ kind: "portal", mode: "grant", agent })}
            onRevokePortal={(agent) => setDrawer({ kind: "portal", mode: "revoke", agent })}
            onResetPortalPassword={(agent) => setDrawer({ kind: "resetPortalPassword", agent })}
            onViewDetails={(agent) => navigate(`/parties/agents/${agent.id}`)}
          />
        )}
      </Surface>

      {/* AgentFormDrawer */}
      <AgentFormDrawer
        open={drawer?.kind === "form"}
        mode={(drawer?.kind === "form" ? drawer.mode : "create")}
        agent={drawer?.kind === "form" ? drawer.agent : null}
        onClose={closeDrawer}
        onResetPassword={
          drawer?.kind === "form" && drawer.mode === "edit" && drawer.agent
            ? () => setDrawer({ kind: "resetPortalPassword", agent: drawer.agent as AgentListItem })
            : undefined
        }
      />

      {/* AgentBlacklistDrawer */}
      {drawer?.kind === "blacklist" && (
        <AgentBlacklistDrawer
          open
          mode={drawer.mode}
          agent={drawer.agent}
          onClose={closeDrawer}
        />
      )}

      {/* AgentPortalAccessDrawer */}
      {drawer?.kind === "portal" && (
        <AgentPortalAccessDrawer
          open
          mode={drawer.mode}
          agent={drawer.agent}
          onClose={closeDrawer}
        />
      )}

      {/* ResetPortalPasswordDrawer */}
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
