import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position } from "reactflow";
import "reactflow/dist/style.css";
import * as dagre from "dagre";
import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { AgentDetailModal } from "./agent-detail-modal";

type HierarchyNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  status: string;
  uplineId: string | null;
  directDownlineCount: number;
  // 'agent' for sales-team nodes; 'individual' for staff (admin/manager/editor)
  // surfaced because they're the upline of at least one agent.
  partyType?: string;
  // For partyType='individual' — the User.role string. Drives the per-role
  // color + label on the node so admin / manager / editor / viewer each get
  // their own visual treatment.
  userRole?: string | null;
};

// Labels mirror commission-labels.ts (canonical source). "Manager" is reserved
// for staff User.role; agentLevel="leader" reads as "Leader" everywhere.
const LEVEL_LABELS: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};

/** Tailwind classes per agent level. Design-token based so dark mode works automatically. */
const LEVEL_CLASSES: Record<string, string> = {
  leader:
    "border-amber-300 bg-gradient-to-br from-amber-50 to-yellow-50 text-amber-900 " +
    "dark:border-amber-700/70 dark:from-amber-950/60 dark:to-yellow-950/40 dark:text-amber-100",
  pre_leader:
    "border-sky-300 bg-sky-50 text-sky-900 " +
    "dark:border-sky-700/70 dark:bg-sky-950/60 dark:text-sky-100",
  new_agent:
    "border-emerald-300 bg-emerald-50 text-emerald-900 " +
    "dark:border-emerald-700/70 dark:bg-emerald-950/60 dark:text-emerald-100",
};

// Staff (partyType='individual') visual treatment — distinct color per User.role
// so admin (red) / manager (purple) / editor (indigo) / viewer (slate) are
// each visually distinguishable from agents AND from each other. The label
// surfaces the role verbatim instead of the generic "STAFF".
const STAFF_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  editor: "Editor",
  viewer: "Viewer",
};
const STAFF_ROLE_CLASSES: Record<string, string> = {
  admin:
    "border-rose-300 bg-gradient-to-br from-rose-50 to-pink-50 text-rose-900 " +
    "dark:border-rose-700/70 dark:from-rose-950/60 dark:to-pink-950/40 dark:text-rose-100",
  manager:
    "border-purple-300 bg-purple-50 text-purple-900 " +
    "dark:border-purple-700/70 dark:bg-purple-950/60 dark:text-purple-100",
  editor:
    "border-indigo-300 bg-indigo-50 text-indigo-900 " +
    "dark:border-indigo-700/70 dark:bg-indigo-950/60 dark:text-indigo-100",
  viewer:
    "border-slate-300 bg-slate-50 text-slate-900 " +
    "dark:border-slate-700/70 dark:bg-slate-950/60 dark:text-slate-100",
};
// Fallback for individuals with no User link or an unknown role — keeps the
// node visible without crashing the legend's mental model.
const STAFF_DEFAULT_CLASS =
  "border-violet-300 bg-violet-50 text-violet-900 " +
  "dark:border-violet-700/70 dark:bg-violet-950/60 dark:text-violet-100";

const ORG_NODE_ID = "__org";
// TODO: pull from session/org settings when we expose it to the client.
const ORG_DISPLAY_NAME = "KAEN Properties";

// Client-side total-descendant count. Derived from the flat list, not fetched.
// Cycle-safe: if legacy data has a cycle, we treat the already-visited node as
// a leaf (returns 0) instead of infinitely recursing.
function computeTotalDescendants(list: HierarchyNode[]): Record<string, number> {
  const byUpline = new Map<string | null, string[]>();
  list.forEach((n) => {
    const arr = byUpline.get(n.uplineId) ?? [];
    arr.push(n.id);
    byUpline.set(n.uplineId, arr);
  });
  const totals: Record<string, number> = {};
  const visit = (id: string, inFlight: Set<string>): number => {
    if (totals[id] !== undefined) return totals[id];
    if (inFlight.has(id)) return 0; // cycle guard — don't re-enter
    inFlight.add(id);
    const children = byUpline.get(id) ?? [];
    let sum = children.length;
    for (const childId of children) sum += visit(childId, inFlight);
    inFlight.delete(id);
    totals[id] = sum;
    return sum;
  };
  list.forEach((n) => visit(n.id, new Set()));
  return totals;
}

function AgentNode({ data }: { data: HierarchyNode & { totalDescendantCount: number } }) {
  const isBlacklisted = data.status === "blacklisted";
  // Deactivated agents (Party.status === "inactive") are hidden by default;
  // when the toggle reveals them, mute the node so it's visibly distinct
  // from active agents but less harsh than the blacklisted strike-through.
  const isDeactivated = !isBlacklisted && data.status === "inactive";
  const isStaff = data.partyType === "individual";
  // Staff nodes use a per-User.role color + label. Unknown / missing role
  // falls back to the generic violet treatment so the node still renders.
  const baseClass = isStaff
    ? (data.userRole && STAFF_ROLE_CLASSES[data.userRole]) || STAFF_DEFAULT_CLASS
    : LEVEL_CLASSES[data.agentLevel ?? "new_agent"] ?? LEVEL_CLASSES.new_agent;
  const levelLabel = isStaff
    ? (data.userRole && STAFF_ROLE_LABELS[data.userRole]) || "Staff"
    : LEVEL_LABELS[data.agentLevel ?? ""] ?? (data.agentLevel ?? "—").replace("_", " ");

  return (
    <div
      data-status={data.status}
      data-party-type={data.partyType}
      data-user-role={data.userRole ?? undefined}
      className={cn(
        "min-w-[160px] rounded-2xl border-2 px-3.5 py-2.5 shadow-sm backdrop-blur-sm transition",
        "hover:shadow-md hover:-translate-y-0.5",
        isBlacklisted
          ? "border-gray-300 bg-gray-100 text-gray-400 line-through opacity-70 " +
              "dark:border-gray-700 dark:bg-gray-900/40"
          : isDeactivated
            ? "border-dashed border-muted-foreground/30 bg-muted/40 text-muted-foreground opacity-60"
            : baseClass,
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="text-[13px] font-bold leading-tight">{data.displayName}</div>
      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wide opacity-75">
        {levelLabel}
        {data.totalDescendantCount > 0 && ` · ${data.totalDescendantCount} below`}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function OrgRootNode({ data }: { data: { label: string; agentCount: number } }) {
  return (
    <div
      className={cn(
        "min-w-[220px] rounded-2xl border-2 border-amber-500/80 px-4 py-3",
        "bg-gradient-to-br from-amber-400/25 via-amber-500/20 to-yellow-500/25",
        "shadow-[0_10px_30px_-8px_rgba(212,175,55,0.45)] backdrop-blur-md",
        "dark:border-amber-500/60 dark:from-amber-500/15 dark:via-amber-600/10 dark:to-yellow-600/15",
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/25">
          <Building2 className="h-5 w-5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-amber-700/90 dark:text-amber-300/90">
            Organization
          </div>
          <div className="truncate text-sm font-bold text-amber-950 dark:text-amber-50">
            {data.label}
          </div>
          {data.agentCount > 0 && (
            <div className="mt-0.5 text-[10px] font-medium text-amber-800/80 dark:text-amber-200/80">
              {data.agentCount} agent{data.agentCount === 1 ? "" : "s"} total
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode, org: OrgRootNode };

// Dagre layout — proven hierarchical algorithm. Every rootless agent
// connects to the synthetic org root, so the tree always has a single top.
function layoutWithDagre(list: HierarchyNode[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 64, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const NODE_W = 180;
  const NODE_H = 60;
  const ORG_W = 240;
  const ORG_H = 76;

  g.setNode(ORG_NODE_ID, { width: ORG_W, height: ORG_H });
  list.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  list.forEach((n) => {
    if (n.uplineId) g.setEdge(n.uplineId, n.id);
    else g.setEdge(ORG_NODE_ID, n.id);
  });

  dagre.layout(g);
  return g;
}

type AgentTreeViewProps = {
  /**
   * When true, the tree includes deactivated (Party.status === "inactive")
   * agents alongside the active ones, styled muted so they're visibly
   * distinct. Default false to keep the active org chart clean.
   */
  includeDeactivated?: boolean;
};

export function AgentTreeView({ includeDeactivated = false }: AgentTreeViewProps = {}) {
  const hierarchy = useQuery({
    queryKey: ["agent-hierarchy", { includeDeactivated }],
    queryFn: () =>
      apiFetch<{ data: HierarchyNode[] }>(
        includeDeactivated
          ? "/parties/agents/hierarchy?includeDeactivated=1"
          : "/parties/agents/hierarchy",
      ),
    staleTime: 60_000,
    gcTime: 300_000,
    placeholderData: (prev) => prev,
  });
  const [selected, setSelected] = useState<HierarchyNode | null>(null);

  const { nodes, edges } = useMemo(() => {
    const list = hierarchy.data?.data ?? [];
    if (list.length === 0) return { nodes: [], edges: [] };

    const totals = computeTotalDescendants(list);
    const graph = layoutWithDagre(list);

    type RFNode = {
      id: string;
      type: string;
      position: { x: number; y: number };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: any;
    };

    const orgPos = graph.node(ORG_NODE_ID);
    const rfNodes: RFNode[] = [
      {
        id: ORG_NODE_ID,
        type: "org",
        position: { x: orgPos.x - orgPos.width / 2, y: orgPos.y - orgPos.height / 2 },
        data: { label: ORG_DISPLAY_NAME, agentCount: list.length },
      },
      ...list.map((n) => {
        const pos = graph.node(n.id);
        return {
          id: n.id,
          type: "agent",
          position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
          data: { ...n, totalDescendantCount: totals[n.id] ?? 0 },
        };
      }),
    ];

    const edgeStyle = { stroke: "var(--border)", strokeWidth: 1.5 };
    const rfEdges = list.map((n) => {
      const source = n.uplineId ?? ORG_NODE_ID;
      return {
        id: `${source}->${n.id}`,
        source,
        target: n.id,
        type: "smoothstep",
        style: edgeStyle,
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [hierarchy.data]);

  if (hierarchy.isLoading) {
    return (
      <div className="h-[70vh] animate-pulse rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--card-border)] bg-[var(--page-bg)] p-12 text-center text-sm text-[var(--text-muted)]">
        No agents yet. Add agents and set their upline to see the team tree here —
        every agent with no upline will report directly to {ORG_DISPLAY_NAME}.
      </div>
    );
  }

  return (
    <div style={{ height: "70vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        onNodeClick={(_, node) => {
          if (node.id === ORG_NODE_ID) return; // synthetic node — not clickable
          setSelected(node.data as HierarchyNode);
        }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      <AgentDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        agent={selected}
      />
    </div>
  );
}
