export type PortalTeamCard = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  emailMasked: string | null;
  phoneMasked: string | null;
};

export type PortalTeamResponse = {
  upline: PortalTeamCard | null;
  directDownlines: PortalTeamCard[];
};

/**
 * One node in the agent's upline chain. Mirrors PortalTeamCard but adds
 * `isSelf` so the UI can highlight the leaf.
 *
 * Privacy: emails/phones are NOT exposed for the upline chain — agents
 * shouldn't see their manager's contact details by default. The portal
 * keeps those masked-or-omitted to match how the org tree is normally
 * gated.
 */
export type PortalUplineNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  isSelf: boolean;
};

/**
 * Upline chain response. `chain` is ordered ROOT-FIRST → LEAF-LAST so
 * the UI can render it top-down without reversing. The synthetic
 * organization root is returned in `organization` separately so the
 * UI can render it as a distinct top-of-tree node (matching the admin
 * agent-tree-view's "KAEN Properties" root).
 */
export type PortalUplineChainResponse = {
  organization: {
    id: string;
    name: string;
  };
  chain: PortalUplineNode[];
};

/**
 * One node in the caller's downline subtree. Unlike the upline chain
 * (privacy-gated to id/name/level), Leaders/Pre-Leaders need full contact
 * info for the people who report to them — they can't manage a team without
 * being able to call them. `uplineId` is always set and is either the caller
 * themselves (direct downline, depth=1) or another node already in the list.
 */
export type PortalDownlineNode = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  uplineId: string;
  depth: number;
};

/**
 * Flat list of every agent in the caller's subtree (recursive, all levels
 * below). The UI builds the tree client-side by grouping on `uplineId`.
 * Blacklisted agents are excluded. Depth-cap 20 for cycle safety.
 */
export type PortalDownlinesResponse = {
  downlines: PortalDownlineNode[];
};
