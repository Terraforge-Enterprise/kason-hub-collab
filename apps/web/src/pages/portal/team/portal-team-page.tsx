import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronDown, GitBranch, Mail, Phone, User, Users } from "lucide-react";
import { toast } from "sonner";
import { portalApiFetch } from "@/lib/portal-api";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Portal — Agent Reporting Line + Team
 *
 * Read-only view of the caller's place in the org, rendered as ONE top-down
 * chart: organization root → upline chain → the caller (YOU) → their downline
 * subtree. Mirrors the admin agent tree (agent-tree-view.tsx) in style.
 *
 * Privacy: upline nodes show name + level only (no contact). Downline nodes
 * DO show contact info — a Leader needs to actually reach their own team.
 * Backend contract: `/team/upline-chain` (self-inclusive, root-first) and
 * `/team/downlines` (flat subtree with uplineId + depth) — see
 * apps/api/src/modules/portal/team/portal.team.repository.ts.
 */

type UplineNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  isSelf: boolean;
};

type UplineChainResponse = {
  data: {
    organization: { id: string; name: string };
    chain: UplineNode[];
  };
};

type DownlineNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  uplineId: string;
  depth: number;
};

type DownlinesResponse = {
  data: {
    downlines: DownlineNode[];
  };
};

// Same vocabulary as the admin tree (LEVEL_LABELS in agent-tree-view.tsx).
// Keep in sync — these are user-facing labels for the DB-level enum values.
// "Manager" is the staff User.role; agentLevel="leader" reads as "Leader".
const LEVEL_LABELS: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};

const LEVEL_TONE: Record<
  string,
  { ring: string; chip: string; chipText: string; iconBg: string; iconColor: string }
> = {
  leader: {
    ring: "border-amber-300/70 dark:border-amber-700/70",
    chip: "bg-amber-500/15 border-amber-500/30",
    chipText: "text-amber-700 dark:text-amber-300",
    iconBg: "bg-amber-500/15",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  pre_leader: {
    ring: "border-sky-300/70 dark:border-sky-700/70",
    chip: "bg-sky-500/15 border-sky-500/30",
    chipText: "text-sky-700 dark:text-sky-300",
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-600 dark:text-sky-400",
  },
  new_agent: {
    ring: "border-emerald-300/70 dark:border-emerald-700/70",
    chip: "bg-emerald-500/15 border-emerald-500/30",
    chipText: "text-emerald-700 dark:text-emerald-300",
    iconBg: "bg-emerald-500/15",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
};

const FALLBACK_TONE = LEVEL_TONE.new_agent;

function levelLabel(level: string | null): string {
  if (!level) return "—";
  return LEVEL_LABELS[level] ?? level.replace(/_/g, " ");
}

function levelTone(level: string | null) {
  return LEVEL_TONE[level ?? ""] ?? FALLBACK_TONE;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function OrgRootCard({ name }: { name: string }) {
  return (
    <GlowCard
      glowColor="gold"
      className="p-5 bg-background/40 backdrop-blur-xl border border-amber-500/40"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/20">
          <Building2 className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-700/90 dark:text-amber-300/90">
            Organization · Super Admin
          </div>
          <div className="truncate text-base font-bold text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">Top of the hierarchy</div>
        </div>
      </div>
    </GlowCard>
  );
}

function ChainNodeCard({
  node,
  position,
  total,
}: {
  node: UplineNode;
  position: number; // 1-indexed, after the org root
  total: number;
}) {
  const tone = levelTone(node.agentLevel);
  const isSelf = node.isSelf;

  // Self gets the gold glow + bolder ring to draw the eye to the leaf.
  // Others get a subtler tone matching their level.
  return (
    <GlowCard
      glowColor={isSelf ? "gold" : "blue"}
      className={cn(
        "p-5 bg-background/40 backdrop-blur-xl border",
        isSelf
          ? "border-amber-500/60 ring-2 ring-amber-500/40 ring-offset-2 ring-offset-background"
          : tone.ring,
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
            tone.iconBg,
          )}
        >
          <User className={cn("h-6 w-6", tone.iconColor)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            <span>
              Level {position} of {total}
            </span>
            {isSelf && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-[1px] text-[10px] font-bold text-amber-700 dark:text-amber-300">
                YOU
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-base font-bold text-foreground">
            {node.displayName}
          </div>
          <div className="mt-1.5">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                tone.chip,
                tone.chipText,
              )}
            >
              {levelLabel(node.agentLevel)}
            </span>
          </div>
        </div>
      </div>
    </GlowCard>
  );
}

function Connector() {
  // Vertical line + chevron between successive cards. Pure decoration.
  return (
    <div className="flex flex-col items-center" aria-hidden>
      <div className="h-4 w-px bg-border/80" />
      <ChevronDown className="h-4 w-4 text-muted-foreground/70" />
      <div className="h-2 w-px bg-border/80" />
    </div>
  );
}

function DownlineCard({ node }: { node: DownlineNode }) {
  const tone = levelTone(node.agentLevel);
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", tone.iconBg)}>
            <User className={cn("h-5 w-5", tone.iconColor)} />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground truncate">{node.displayName}</span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-[1px] text-[10px] font-semibold shrink-0",
                  tone.chip,
                  tone.chipText,
                )}
              >
                {levelLabel(node.agentLevel)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {node.primaryEmail && (
                <a
                  href={`mailto:${node.primaryEmail}`}
                  className="inline-flex items-center gap-1 hover:text-foreground transition"
                >
                  <Mail className="h-3 w-3" />
                  <span className="break-all">{node.primaryEmail}</span>
                </a>
              )}
              {node.primaryPhone && (
                <a
                  href={`tel:${node.primaryPhone}`}
                  className="inline-flex items-center gap-1 hover:text-foreground transition"
                >
                  <Phone className="h-3 w-3" />
                  <span>{node.primaryPhone}</span>
                </a>
              )}
              {!node.primaryEmail && !node.primaryPhone && (
                <span className="italic">No contact info on file</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Render the caller's downline subtree from a flat list. The list is grouped
 * by `uplineId` so each node renders its children indented underneath, giving
 * a visual hierarchy that mirrors the actual reporting graph.
 */
function DownlineSubtree({
  nodes,
  parentId,
}: {
  nodes: DownlineNode[];
  parentId: string;
}) {
  const childrenByParent = useMemo(() => {
    const map = new Map<string, DownlineNode[]>();
    for (const n of nodes) {
      if (!map.has(n.uplineId)) map.set(n.uplineId, []);
      map.get(n.uplineId)!.push(n);
    }
    return map;
  }, [nodes]);

  function renderChildren(uplineId: string) {
    const children = childrenByParent.get(uplineId);
    if (!children || children.length === 0) return null;
    return (
      <div className="space-y-2">
        {children.map((child) => {
          const grandchildren = childrenByParent.get(child.id);
          return (
            <div key={child.id} className="space-y-2">
              <DownlineCard node={child} />
              {grandchildren && grandchildren.length > 0 && (
                <div className="ml-5 border-l-2 border-border/40 pl-4 space-y-2">
                  {renderChildren(child.id)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return renderChildren(parentId);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-12 w-64 bg-muted rounded" />
      <div className="space-y-3 max-w-md mx-auto">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function PortalTeamPage() {
  const upline = useQuery({
    queryKey: ["portal-team-upline-chain"],
    queryFn: () =>
      portalApiFetch<UplineChainResponse>("/team/upline-chain"),
    staleTime: 60_000,
  });

  // Downlines (recursive subtree) — fires alongside the upline query so
  // Leaders/Pre-Leaders see their team without a second render pass. New
  // Agents get back an empty array, which renders as a friendly empty state.
  const downlines = useQuery({
    queryKey: ["portal-team-downlines"],
    queryFn: () =>
      portalApiFetch<DownlinesResponse>("/team/downlines"),
    staleTime: 60_000,
  });

  // Toast on transient load errors. Don't toast on 404 — surface inline.
  useEffect(() => {
    if (upline.isError) {
      toast.error("Failed to load your reporting line. Please refresh.");
    }
  }, [upline.isError]);

  useEffect(() => {
    if (downlines.isError) {
      toast.error("Failed to load your team. Please refresh.");
    }
  }, [downlines.isError]);

  if (upline.isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <GitBranch className="h-8 w-8 text-primary" />
            My Reporting Line
          </h1>
          <p className="text-muted-foreground">Your chain of command, top down.</p>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  if (upline.isError) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <GitBranch className="h-8 w-8 text-primary" />
            My Reporting Line
          </h1>
        </div>
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-8 text-center text-sm text-rose-500">
            Failed to load your reporting line. Please refresh the page.
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = upline.data!.data;
  const { organization, chain } = data;

  // Self-only chain (length 1) → caller is at the top. Everyone else has at
  // least one upline above them in the chain.
  const isAtTop = chain.length === 1 && chain[0].isSelf;

  // The self node's id is the root of the downline subtree.
  const selfNode = chain.find((n) => n.isSelf);
  const selfId = selfNode?.id ?? null;
  const downlineList = downlines.data?.data.downlines ?? [];
  const directDownlineCount = downlineList.filter((n) => n.depth === 1).length;
  const hasTeam = downlineList.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <GitBranch className="h-8 w-8 text-primary" />
          My Reporting Line
        </h1>
        <p className="text-muted-foreground">
          Your place in {organization.name} — the line above you, and your team
          below.
        </p>
      </div>

      {/*
        One unified top-down org chart:
          Org root → upline chain → YOU → your team (downline subtree).
        The downline flows directly beneath the self node so the whole view
        reads as a single chain of command instead of two disconnected lists.
      */}
      <div className="mx-auto max-w-md space-y-0">
        <OrgRootCard name={organization.name} />
        {chain.map((node, idx) => (
          <div key={node.id}>
            <Connector />
            <ChainNodeCard node={node} position={idx + 1} total={chain.length} />
          </div>
        ))}

        {/* Your team — continues the tree directly under the YOU node. */}
        {downlines.isLoading ? (
          <>
            <Connector />
            <div className="space-y-2 animate-pulse" aria-hidden>
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-20 rounded-lg bg-muted/60" />
              ))}
            </div>
          </>
        ) : hasTeam && selfId ? (
          <>
            <Connector />
            <div className="mb-3 flex items-center justify-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              <span>
                Your team · {downlineList.length} agent
                {downlineList.length === 1 ? "" : "s"} · {directDownlineCount}{" "}
                direct report{directDownlineCount === 1 ? "" : "s"}
              </span>
            </div>
            <DownlineSubtree nodes={downlineList} parentId={selfId} />
          </>
        ) : null}
      </div>

      {/* No-team note — only when nobody reports under the caller. */}
      {!downlines.isLoading && !downlines.isError && !hasTeam && (
        <div className="mx-auto max-w-md">
          <Card className="bg-background/60 backdrop-blur-xl border-border/50">
            <CardContent className="p-4 text-center text-xs text-muted-foreground">
              {isAtTop
                ? `You report directly to ${organization.name}, and no agents report to you yet.`
                : "No agents report to you yet — when they're assigned to your team, they'll appear here with their contact details."}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Footer note — privacy reminder */}
      <div className="mx-auto max-w-md text-center text-xs text-muted-foreground">
        This view is read-only. Contact your manager to update your reporting line.
      </div>
    </div>
  );
}
