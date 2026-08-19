import { portalApiFetch } from "@/lib/portal-api";

export type AgentHomeDomain =
  | "pipeline"
  | "sales-claim"
  | "renovation-claim"
  | "commission";

export interface AgentHomeFeedRow {
  domain: AgentHomeDomain;
  id: string;
  label: string;
  href: string;
  updatedAt: string;
}

export interface AgentHomeSummary {
  pendingActions: AgentHomeFeedRow[];
  pipeline: { counts: Record<string, number> } | null;
  salesClaims: { counts: Record<string, number>; approvedThisMonth: number } | null;
  renovationClaims: { counts: Record<string, number>; approvedThisMonth: number } | null;
  commission: { earnedThisMonth: number; submittedPending: number } | null;
  recentActivity: AgentHomeFeedRow[];
  errors: AgentHomeDomain[];
}

export async function fetchAgentHomeSummary(): Promise<AgentHomeSummary> {
  const res = await portalApiFetch<{ data: AgentHomeSummary }>("/agent-home/summary");
  return res.data;
}
