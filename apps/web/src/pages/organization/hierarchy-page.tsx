import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { AgentTreeView } from "@/pages/parties/agent-tree-view";
import { TeamAreaTabs } from "./team-area-tabs";

type HierarchySummary = {
  id: string;
  agentLevel: string | null;
  uplineId: string | null;
  // 'agent' or 'individual' (staff). Staff appear when they're the upline of
  // at least one agent — they don't have an agentLevel.
  partyType?: string;
};

export default function OrganizationHierarchyPage() {
  const [includeDeactivated, setIncludeDeactivated] = useState(false);

  // Lightweight summary query for the PageHeader metrics — cached 60s, shared
  // with the tree view via TanStack Query key collision below.
  const summary = useQuery({
    queryKey: ["agent-hierarchy", { includeDeactivated }],
    queryFn: () =>
      apiFetch<{ data: HierarchySummary[] }>(
        includeDeactivated
          ? "/parties/agents/hierarchy?includeDeactivated=1"
          : "/parties/agents/hierarchy",
      ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const list = summary.data?.data ?? [];
  // "Manager" is the staff User.role; agentLevel="leader" reads as "Leader"
  // everywhere on the agent surface (commission-labels.ts is the source).
  const leaderCount = list.filter((a) => a.agentLevel === "leader").length;
  const preLeaderCount = list.filter((a) => a.agentLevel === "pre_leader").length;
  const newAgentCount = list.filter((a) => a.agentLevel === "new_agent").length;
  const staffCount = list.filter((a) => a.partyType === "individual").length;
  const agentCount = list.filter((a) => a.partyType === "agent" || !a.partyType).length;

  return (
    <div className="space-y-6">
      <TeamAreaTabs activeTab="hierarchy" />
      <PageHeader
        title="Organization hierarchy"
        description="Visual map of your reporting lines, rooted at the organization. Staff (admins / managers / editors) appear when they're the upline of at least one agent."
        metrics={[
          { label: "Total nodes", value: String(list.length), hint: "Agents + staff uplines" },
          { label: "Leaders", value: String(leaderCount), hint: "Top agent rank" },
          { label: "Pre-Leaders", value: String(preLeaderCount), hint: "Senior agents" },
          { label: "New Agents", value: String(newAgentCount), hint: "Entry-level agents" },
        ]}
      />

      <Surface
        title="Team tree"
        description={`${agentCount} agent${agentCount === 1 ? "" : "s"}${staffCount > 0 ? ` + ${staffCount} staff upline${staffCount === 1 ? "" : "s"}` : ""} · ${leaderCount} leader${leaderCount === 1 ? "" : "s"} · ${preLeaderCount + newAgentCount} individual contributor${preLeaderCount + newAgentCount === 1 ? "" : "s"}`}
      >
        <div className="mb-3 flex items-center justify-end">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition">
            <input
              type="checkbox"
              checked={includeDeactivated}
              onChange={(e) => setIncludeDeactivated(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer rounded border-border accent-[var(--primary)]"
            />
            Show deactivated agents
          </label>
        </div>
        <AgentTreeView includeDeactivated={includeDeactivated} />
      </Surface>
    </div>
  );
}
