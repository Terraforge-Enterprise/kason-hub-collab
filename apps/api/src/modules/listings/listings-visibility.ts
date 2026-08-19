export interface UnitVisibilityFields {
  id: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  // The agent who sourced this unit (post-refactor: sourcingAgentId IS NOT
  // NULL replaces the old sourceFlag === AGENT_SOURCED check). Pending
  // (unapproved) units no longer live on Listing — they live in
  // UnitSubmission. Every Listing row is approved by definition.
  sourcingAgentId: string | null;
  // The agent assigned as in-charge of this unit. Acts as an override:
  // that agent always sees the unit regardless of listingStatus,
  // visibilityMode, or hidden lists.
  inChargePartyId: string | null;
}

export function canAgentSeeUnit(
  unit: UnitVisibilityFields,
  agentPartyId: string,
  grantedPartyIds: string[] = [],
): boolean {
  // In-charge override: the assigned agent always sees the unit. Drafts
  // and RESTRICTED-without-grant included — the in-charge agent needs
  // visibility into units they're responsible for.
  if (unit.inChargePartyId && unit.inChargePartyId === agentPartyId) return true;
  // Restricted: must have an explicit grant.
  if (unit.visibilityMode === "RESTRICTED") {
    return grantedPartyIds.includes(agentPartyId);
  }
  // Public: visible unless explicitly hidden.
  return !unit.hiddenFromPartyIds.includes(agentPartyId);
}
