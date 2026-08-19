-- Backfill Unit.ownerPartyId from the property's SINGLE active LandlordTenancy.
--
-- Owner money is now attributed PER-UNIT via Listing.ownerPartyId (replacing the
-- property-level LandlordTenancy.landlordId derivation). This one-time, additive
-- backfill seeds ownerPartyId for the unambiguous case: a property that has
-- EXACTLY ONE distinct active landlord. We copy that landlord onto every Unit
-- under that property whose ownerPartyId is still NULL (never overwrite an owner
-- the A-picker already assigned).
--
-- Properties with 0 or >=2 distinct active landlords are LEFT NULL — multi-owner
-- buildings must be assigned per-unit via the inventory owner picker (the re-point
-- is precisely to disambiguate these). This migration is idempotent: re-running it
-- only ever fills rows that are still NULL, and the single-landlord set is fixed.

UPDATE "Unit" u
SET "ownerPartyId" = single_owner.landlord_id
FROM (
  SELECT
    lt."propertyId"                          AS property_id,
    -- HAVING below guarantees exactly one distinct landlord; take it. (uuid has no
    -- MIN() aggregate, so pick the sole element of the distinct set.)
    (array_agg(DISTINCT lt."landlordId"))[1] AS landlord_id
  FROM "LandlordTenancy" lt
  WHERE lt."status" = 'active'
  GROUP BY lt."propertyId"
  HAVING COUNT(DISTINCT lt."landlordId") = 1
) AS single_owner
JOIN "Apartment" a ON a."propertyId" = single_owner.property_id
WHERE u."apartmentId" = a."id"
  AND u."ownerPartyId" IS NULL;
