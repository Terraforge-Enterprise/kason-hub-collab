// Single source of truth for the commission-domain enums + their human labels.
//
// Agent levels and claim types are Zod-enum-bound at the backend (see
// `@kason/shared/schemas/level-thresholds.ts` and the create-claim schema), so
// the values themselves are not admin-editable. What we centralise here is:
//   1. The fixed order of values (so dropdowns don't drift between consumers).
//   2. The display label for each value (so we don't re-stringify them).
//
// Every dropdown that renders agent level OR claim type MUST import from this
// file. Don't repeat the literals — they have already drifted in the past.

export const AGENT_LEVELS = ["new_agent", "pre_leader", "leader"] as const;
export type AgentLevel = (typeof AGENT_LEVELS)[number];

export const CLAIM_TYPES = [
  "tenant_portion",
  "listing_portion",
  "tenant_listing_portion",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  tenant_portion: "Tenant Portion",
  listing_portion: "Listing Portion",
  tenant_listing_portion: "Tenant + Listing Portion",
};

const AGENT_LEVEL_LABELS: Record<AgentLevel, string> = {
  new_agent: "New Agent",
  pre_leader: "Pre Leader",
  leader: "Leader",
};

export function humanizeClaimType(value: string): string {
  return CLAIM_TYPE_LABELS[value as ClaimType] ?? value;
}

export function humanizeAgentLevel(value: string): string {
  return AGENT_LEVEL_LABELS[value as AgentLevel] ?? value;
}

// Claim status labels. The DB column stores snake_case values; UI pills and
// filter dropdowns render them via this helper so users never see underscores.
// Add new statuses here as the FSM grows so the label stays consistent across
// admin + agent surfaces.
const CLAIM_STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  submitted: "submitted",
  approved: "approved",
  amended: "amended",
  needs_amendment: "needs amendment",
  rejected: "rejected",
  paid: "paid",
  cancelled: "cancelled",
  deleted: "deleted",
};

export function humanizeClaimStatus(value: string): string {
  return CLAIM_STATUS_LABELS[value] ?? value.replace(/_/g, " ");
}

/** Pre-built `<option>`-shape list for agent-level dropdowns. */
export const AGENT_LEVEL_OPTIONS: Array<{ value: AgentLevel; label: string }> =
  AGENT_LEVELS.map((value) => ({ value, label: humanizeAgentLevel(value) }));

/** Pre-built `<option>`-shape list for claim-type dropdowns. */
export const CLAIM_TYPE_OPTIONS: Array<{ value: ClaimType; label: string }> =
  CLAIM_TYPES.map((value) => ({ value, label: humanizeClaimType(value) }));
