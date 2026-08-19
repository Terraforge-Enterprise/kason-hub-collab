-- Preserve ListingVisibilityGrant audit trail when a Party is deleted.
-- Legal evidence of who could see which unit must outlive the data subject,
-- mirroring the phase1_pdpa_fk_fix pattern already applied to TenantConsent
-- and PdpaRequest. See review finding Schema #3 (HIGH).

ALTER TABLE "ListingVisibilityGrant" DROP CONSTRAINT "ListingVisibilityGrant_partyId_fkey";
ALTER TABLE "ListingVisibilityGrant" ADD CONSTRAINT "ListingVisibilityGrant_partyId_fkey"
    FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Safety net for the LVG index that should have been created in
-- phase1_agent_indexes. That migration skips it if LVG didn't exist yet
-- (alphabetical-order quirk in prisma migrate deploy).
CREATE INDEX IF NOT EXISTS "ListingVisibilityGrant_organizationId_partyId_idx"
    ON "ListingVisibilityGrant"("organizationId", "partyId");
