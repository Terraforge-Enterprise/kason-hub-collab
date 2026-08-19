-- Allow one unit code to host multiple rentable rows distinguished by unit type
-- (e.g. A-11-43 / Master, A-11-43 / Medium, A-11-43 / Small in the same condo).
-- The previous constraint allowed only one row per (org, property, unitCode)
-- regardless of unit type, which blocked legitimate multi-room listings.
--
-- Old constraint was strictly tighter than the new one, so any pre-existing row
-- already satisfies the new uniqueness shape — no data backfill needed.

DROP INDEX IF EXISTS "Unit_organizationId_propertyId_unitCode_key";

CREATE UNIQUE INDEX "Unit_organizationId_propertyId_unitCode_unitType_key"
  ON "Unit"("organizationId", "propertyId", "unitCode", "unitType");
