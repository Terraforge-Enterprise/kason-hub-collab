import { canAgentSeeUnit } from "../../listings/listings-visibility";
import { findGrantsForAgent, findListingsForAgent } from "./portal.listings.repository";

/**
 * Strip owner-contact fields when the caller is NOT the sourcing agent on an
 * agent-sourced listing.  Prevents cross-agent leakage of owner-trust details
 * (see requirements doc §2.6).  Sourcing agent + Super Admin see everything;
 * for Phase 1 the portal service applies the mask and admin routes stay full.
 */
function maskOwnerContact<
  T extends {
    sourceFlag: "COMPANY" | "AGENT_SOURCED";
    sourcingAgentId: string | null;
    inChargeName: string | null;
    inChargePartyId: string | null;
  },
>(unit: T, agentPartyId: string): T {
  // The in-charge agent is allowed to see their own assignment, even on
  // an AGENT_SOURCED listing they didn't source — masking would hide
  // their own name from them.
  if (unit.inChargePartyId && unit.inChargePartyId === agentPartyId) return unit;
  if (unit.sourceFlag === "AGENT_SOURCED" && unit.sourcingAgentId !== agentPartyId) {
    return { ...unit, inChargeName: null, inChargePartyId: null };
  }
  return unit;
}

/**
 * Inventory grid — only approved Listings the agent has visibility on.
 *
 * Pending agent submissions live in UnitSubmission (see
 * `findOwnPendingSubmissions`) and are surfaced by a separate query. They
 * never appear in the inventory grid by construction — the Listing table
 * physically cannot contain them after the three-table refactor.
 */
export async function listVisibleUnits(orgId: string, agentPartyId: string) {
  const [units, grants] = await Promise.all([
    findListingsForAgent(orgId, agentPartyId, { excludeRejected: true }),
    findGrantsForAgent(orgId, agentPartyId),
  ]);
  const grantedSet = new Set(grants.map((g) => g.unitId));
  return units
    .filter((u) =>
      canAgentSeeUnit(
        {
          id: u.id,
          visibilityMode: u.visibilityMode,
          hiddenFromPartyIds: u.hiddenFromPartyIds,
          // Every Listing is approved (pending lives in UnitSubmission).
          // A Listing with sourcingAgentId IS NOT NULL is agent-sourced;
          // canAgentSeeUnit no longer gates on a "pending" flag.
          sourcingAgentId: u.sourcingAgentId,
          inChargePartyId: u.inChargePartyId,
        },
        agentPartyId,
        grantedSet.has(u.id) ? [agentPartyId] : [],
      ),
    )
    .map((u) => maskOwnerContact(u, agentPartyId));
}

export async function getVisibleUnit(
  orgId: string,
  agentPartyId: string,
  unitId: string,
) {
  // Same admit set as the grid — no separate "include rejected" path exists
  // anymore. Rejected proposals are UnitSubmission rows, not Listings, and
  // are surfaced via findOwnPendingSubmissions when the SPA wants to render
  // a rejected detail page.
  const [units, grants] = await Promise.all([
    findListingsForAgent(orgId, agentPartyId, { excludeRejected: false }),
    findGrantsForAgent(orgId, agentPartyId),
  ]);
  const grantedSet = new Set(grants.map((g) => g.unitId));
  const visible = units
    .filter((u) =>
      canAgentSeeUnit(
        {
          id: u.id,
          visibilityMode: u.visibilityMode,
          hiddenFromPartyIds: u.hiddenFromPartyIds,
          sourcingAgentId: u.sourcingAgentId,
          inChargePartyId: u.inChargePartyId,
        },
        agentPartyId,
        grantedSet.has(u.id) ? [agentPartyId] : [],
      ),
    )
    .map((u) => maskOwnerContact(u, agentPartyId));
  return visible.find((u) => u.id === unitId) ?? null;
}
