-- Portal hot-path indexes for "records belonging to this agent in this org".
-- Without these, the portal dashboards degrade to seq scans as volume grows.
-- See review finding Schema #5 (MEDIUM).
--
-- Made idempotent + tolerant of sibling-migration ordering. On Supabase,
-- prisma migrate deploy runs migrations in alphabetical order, so this
-- migration may run BEFORE phase1_expansion (which creates
-- ListingVisibilityGrant) and phase1_listing_grant_restrict (which also
-- owns the LVG index). IF NOT EXISTS + conditional DO block keeps this
-- migration working in either order.

CREATE INDEX IF NOT EXISTS "DealParty_organizationId_agentPartyId_idx"
    ON "DealParty"("organizationId", "agentPartyId");

CREATE INDEX IF NOT EXISTS "TaSplit_organizationId_agentPartyId_idx"
    ON "TaSplit"("organizationId", "agentPartyId");

CREATE INDEX IF NOT EXISTS "Shortfall_organizationId_agentPartyId_idx"
    ON "Shortfall"("organizationId", "agentPartyId");

DO $$
BEGIN
  IF to_regclass('"ListingVisibilityGrant"') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "ListingVisibilityGrant_organizationId_partyId_idx"
      ON "ListingVisibilityGrant"("organizationId", "partyId");
  END IF;
END$$;
