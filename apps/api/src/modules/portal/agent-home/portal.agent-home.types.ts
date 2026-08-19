import type { SalesClaimStatus } from "../../sales-claims/sales-claims.types";
import type { RenovationClaimStatus } from "../../renovation-claims/renovation-claims.types";

export type SalesUnitStatus =
  | "pending_review"
  | "approved"
  | "needs_amendment"
  | "edited_post_approval";

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
  updatedAt: string; // ISO
}

export interface AgentHomeSummary {
  pendingActions: AgentHomeFeedRow[];
  pipeline: { counts: Partial<Record<SalesUnitStatus, number>> } | null;
  salesClaims: {
    counts: Partial<Record<SalesClaimStatus, number>>;
    approvedThisMonth: number;
  } | null;
  renovationClaims: {
    counts: Partial<Record<RenovationClaimStatus, number>>;
    approvedThisMonth: number;
  } | null;
  commission: {
    earnedThisMonth: number;
    submittedPending: number;
  } | null;
  recentActivity: AgentHomeFeedRow[];
  /** Domains that failed to load. Successful slices are still populated. */
  errors: AgentHomeDomain[];
}
