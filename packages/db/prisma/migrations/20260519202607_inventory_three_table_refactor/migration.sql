-- =============================================================================
-- Inventory three-table refactor migration.
--
-- Order:
--   1. Create enums + new tables (Apartment, UnitSubmission, PropertySubmission)
--   2. Backfill Apartment from distinct (orgId, propertyId, unitCode) groups
--   3. Add Listing.apartmentId, backfill it, set NOT NULL
--   4. Backfill UnitSubmission from pending agent units; DELETE those units
--   5. Backfill PropertySubmission from pending agent properties; DELETE them
--   6. Drop dead columns from Unit (now Listing) and Property
--   7. Drop UnitListingModeTransition table
--   8. Drop UnitSource enum
--   9. Add foreign keys for new tables
--
-- This is destructive and not automatically reversible. If running against
-- non-local environments, take a pg_dump first.
-- =============================================================================

-- Step 1: Create enums + new tables.

CREATE TYPE "ListingMode" AS ENUM ('WHOLE', 'PARTITIONED');
CREATE TYPE "SubmissionState" AS ENUM ('pending', 'needs_amendment', 'approved', 'rejected', 'withdrawn');

CREATE TABLE "Apartment" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"       UUID NOT NULL,
    "propertyId"           UUID NOT NULL,
    "unitCode"             TEXT NOT NULL,
    "listingMode"          "ListingMode" NOT NULL,
    "bedrooms"             INTEGER,
    "bathrooms"            DECIMAL(4,1),
    "floorArea"            DECIMAL(12,2),
    "floor"                INTEGER,
    "facing"               TEXT,
    "furnishingLevel"      TEXT,
    "amenities"            TEXT[] NOT NULL DEFAULT '{}',
    "highlights"           TEXT[] NOT NULL DEFAULT '{}',
    "publishedDescription" TEXT,
    "publishedTitle"       TEXT,
    "photoKeys"            TEXT[] NOT NULL DEFAULT '{}',
    "coverPhotoKey"        TEXT,
    "videoKeys"            TEXT[] NOT NULL DEFAULT '{}',
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Apartment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Apartment_organizationId_propertyId_unitCode_key" ON "Apartment"("organizationId", "propertyId", "unitCode");
CREATE INDEX "Apartment_organizationId_propertyId_idx" ON "Apartment"("organizationId", "propertyId");
CREATE INDEX "Apartment_organizationId_listingMode_idx" ON "Apartment"("organizationId", "listingMode");

ALTER TABLE "Apartment" ADD CONSTRAINT "Apartment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Apartment" ADD CONSTRAINT "Apartment_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UnitSubmission" (
    "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"       UUID NOT NULL,
    "propertyId"           UUID,
    "propertySubmissionId" UUID,
    "unitCode"             TEXT NOT NULL,
    "listingType"          TEXT NOT NULL,
    "listingMode"          "ListingMode" NOT NULL,
    "parentListingId"      UUID,
    "sourcingAgentId"      UUID NOT NULL,
    "submissionState"      "SubmissionState" NOT NULL,
    "amendmentNote"        TEXT,
    "submittedPayload"     JSONB NOT NULL,
    "approvedAt"           TIMESTAMP(3),
    "approvedById"         UUID,
    "approvedListingId"    UUID,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UnitSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnitSubmission_approvedListingId_key" ON "UnitSubmission"("approvedListingId");
CREATE INDEX "UnitSubmission_organizationId_submissionState_createdAt_idx" ON "UnitSubmission"("organizationId", "submissionState", "createdAt");
CREATE INDEX "UnitSubmission_organizationId_sourcingAgentId_submissionState_idx" ON "UnitSubmission"("organizationId", "sourcingAgentId", "submissionState");
CREATE INDEX "UnitSubmission_organizationId_parentListingId_idx" ON "UnitSubmission"("organizationId", "parentListingId");

CREATE TABLE "PropertySubmission" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId"      UUID NOT NULL,
    "propertyCode"        TEXT NOT NULL,
    "proposedName"        TEXT NOT NULL,
    "propertyType"        TEXT NOT NULL,
    "addressLine1"        TEXT NOT NULL,
    "addressLine2"        TEXT,
    "city"                TEXT NOT NULL,
    "state"               TEXT,
    "postalCode"          TEXT,
    "country"             TEXT NOT NULL,
    "sourcingAgentId"     UUID NOT NULL,
    "submissionState"     "SubmissionState" NOT NULL,
    "amendmentNote"       TEXT,
    "submittedPayload"    JSONB NOT NULL,
    "approvedAt"          TIMESTAMP(3),
    "approvedById"        UUID,
    "approvedPropertyId"  UUID,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PropertySubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertySubmission_approvedPropertyId_key" ON "PropertySubmission"("approvedPropertyId");
CREATE INDEX "PropertySubmission_organizationId_submissionState_createdAt_idx" ON "PropertySubmission"("organizationId", "submissionState", "createdAt");
CREATE INDEX "PropertySubmission_organizationId_sourcingAgentId_submissionState_idx" ON "PropertySubmission"("organizationId", "sourcingAgentId", "submissionState");

-- Step 2: Backfill Apartment from existing Unit rows (one per distinct (orgId, propertyId, unitCode)).
-- Snapshot apartment-shared fields from the oldest sibling. Derive listingMode
-- from kinds of active siblings' unitTypes.

INSERT INTO "Apartment" (
  "id", "organizationId", "propertyId", "unitCode", "listingMode",
  "bedrooms", "bathrooms", "floorArea", "floor", "facing", "furnishingLevel",
  "amenities", "highlights", "publishedDescription", "publishedTitle",
  "photoKeys", "coverPhotoKey", "videoKeys",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  src."organizationId",
  src."propertyId",
  src."unitCode",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "Unit" u
      JOIN "RoomType" rt
        ON rt."organizationId" = u."organizationId" AND rt."name" = u."unitType"
      WHERE u."organizationId" = src."organizationId"
        AND u."propertyId" = src."propertyId"
        AND u."unitCode" = src."unitCode"
        AND u."listingStatus" != 'archived'
        AND rt."kind" = 'WHOLE'
    ) THEN 'WHOLE'::"ListingMode"
    ELSE 'PARTITIONED'::"ListingMode"
  END,
  src."bedrooms",
  src."bathrooms",
  src."floorArea",
  src."floor",
  src."facing",
  src."furnishingLevel",
  COALESCE(src."amenities", '{}'),
  COALESCE(src."highlights", '{}'),
  src."publishedDescription",
  src."publishedTitle",
  COALESCE(src."photoKeys", '{}'),
  src."coverPhotoKey",
  COALESCE(src."videoKeys", '{}'),
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT ON ("organizationId", "propertyId", "unitCode") *
  FROM "Unit"
  ORDER BY "organizationId", "propertyId", "unitCode", "createdAt" ASC
) src;

-- Step 3: Add Unit.apartmentId column nullable, backfill, then NOT NULL.

ALTER TABLE "Unit" ADD COLUMN "apartmentId" UUID;

UPDATE "Unit" u
SET "apartmentId" = a."id"
FROM "Apartment" a
WHERE a."organizationId" = u."organizationId"
  AND a."propertyId"     = u."propertyId"
  AND a."unitCode"       = u."unitCode";

DO $$
DECLARE missing INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing FROM "Unit" WHERE "apartmentId" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Apartment backfill failed: % Unit rows have null apartmentId', missing;
  END IF;
END $$;

ALTER TABLE "Unit" ALTER COLUMN "apartmentId" SET NOT NULL;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_apartmentId_fkey"
  FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 4: Backfill UnitSubmission from pending agent units; then DELETE those
-- units so the inventory table doesn't see them.

INSERT INTO "UnitSubmission" (
  "id", "organizationId", "propertyId", "unitCode",
  "listingType", "listingMode",
  "parentListingId", "sourcingAgentId",
  "submissionState", "amendmentNote", "submittedPayload",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  u."organizationId",
  u."propertyId",
  u."unitCode",
  u."unitType",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "RoomType" rt
      WHERE rt."organizationId" = u."organizationId"
        AND rt."name" = u."unitType"
        AND rt."kind" = 'WHOLE'
    ) THEN 'WHOLE'::"ListingMode"
    ELSE 'PARTITIONED'::"ListingMode"
  END,
  NULL,
  u."sourcingAgentId",
  CASE
    WHEN u."sourcingCancelled" THEN 'withdrawn'::"SubmissionState"
    WHEN u."sourcingAmendmentNote" LIKE 'REJECTED:%' THEN 'rejected'::"SubmissionState"
    WHEN u."sourcingAmendmentNote" IS NOT NULL THEN 'needs_amendment'::"SubmissionState"
    ELSE 'pending'::"SubmissionState"
  END,
  CASE
    WHEN u."sourcingAmendmentNote" LIKE 'REJECTED:%'
      THEN substring(u."sourcingAmendmentNote" from 10)
    ELSE u."sourcingAmendmentNote"
  END,
  jsonb_build_object(
    'listing', jsonb_build_object(
      'rentalRate',              u."rentalRate",
      'depositMonths',           u."depositMonths",
      'utilitiesDepositMonths',  u."utilitiesDepositMonths",
      'accessCardDepositPerPcs', u."accessCardDepositPerPcs",
      'accessCardQuantity',      u."accessCardQuantity",
      'parkingQuantity',         u."parkingQuantity",
      'parkingNumbers',          to_jsonb(u."parkingNumbers"),
      'occupancyStatus',         u."occupancyStatus",
      'visibilityMode',          u."visibilityMode"::text,
      'hiddenFromPartyIds',      to_jsonb(u."hiddenFromPartyIds"),
      'inChargePartyId',         u."inChargePartyId",
      'inChargeName',            u."inChargeName"
    ),
    'apartmentShared', jsonb_build_object(
      'bedrooms',             u."bedrooms",
      'bathrooms',            u."bathrooms",
      'floorArea',            u."floorArea",
      'floor',                u."floor",
      'amenities',            to_jsonb(u."amenities"),
      'highlights',           to_jsonb(u."highlights"),
      'publishedDescription', u."publishedDescription",
      'photoKeys',            to_jsonb(u."photoKeys"),
      'coverPhotoKey',        u."coverPhotoKey",
      'videoKeys',            to_jsonb(u."videoKeys")
    )
  ),
  u."createdAt",
  u."updatedAt"
FROM "Unit" u
WHERE u."sourceFlag" = 'AGENT_SOURCED'
  AND u."sourcingApproved" = FALSE
  AND u."sourcingAgentId" IS NOT NULL;

DELETE FROM "Unit"
WHERE "sourceFlag" = 'AGENT_SOURCED'
  AND "sourcingApproved" = FALSE;

-- Step 5: Backfill PropertySubmission from pending agent properties.

INSERT INTO "PropertySubmission" (
  "id", "organizationId", "propertyCode", "proposedName", "propertyType",
  "addressLine1", "addressLine2", "city", "state", "postalCode", "country",
  "sourcingAgentId", "submissionState", "amendmentNote", "submittedPayload",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  p."organizationId",
  p."propertyCode",
  p."name",
  p."propertyType",
  p."addressLine1",
  p."addressLine2",
  p."city",
  p."state",
  p."postalCode",
  p."country",
  p."sourcingAgentId",
  CASE
    WHEN p."sourcingCancelled" THEN 'withdrawn'::"SubmissionState"
    WHEN p."sourcingAmendmentNote" LIKE 'REJECTED:%' THEN 'rejected'::"SubmissionState"
    WHEN p."sourcingAmendmentNote" IS NOT NULL THEN 'needs_amendment'::"SubmissionState"
    ELSE 'pending'::"SubmissionState"
  END,
  CASE
    WHEN p."sourcingAmendmentNote" LIKE 'REJECTED:%' THEN substring(p."sourcingAmendmentNote" from 10)
    ELSE p."sourcingAmendmentNote"
  END,
  jsonb_build_object(
    'managerId',          p."managerId",
    'insuranceProvider',  p."insuranceProvider",
    'insurancePolicyNo',  p."insurancePolicyNo",
    'hasPaxDeduction',    p."hasPaxDeduction",
    'paxDeductionAmount', p."paxDeductionAmount"
  ),
  p."createdAt",
  p."updatedAt"
FROM "Property" p
WHERE p."sourceFlag" = 'AGENT_SOURCED'
  AND p."sourcingApproved" = FALSE
  AND p."sourcingAgentId" IS NOT NULL;

-- Step 5.5: Capture the mapping of soon-to-be-deleted Property → newly
-- inserted PropertySubmission, then DELETE the pending Properties, then
-- re-point any UnitSubmission rows whose propertyId pointed at one of the
-- deleted Properties so the FK we add in Step 9 doesn't fail.
--
-- Without this, UnitSubmissions submitted under a still-pending Property
-- would orphan their propertyId references when Step 5 deletes the Property.
-- The mapping links by (organizationId, propertyCode), which is unique per
-- organization for non-archived Properties.
CREATE TEMP TABLE _property_to_submission AS
SELECT
  p.id  AS old_property_id,
  ps.id AS new_submission_id
FROM "Property" p
JOIN "PropertySubmission" ps
  ON ps."organizationId" = p."organizationId"
 AND ps."propertyCode"   = p."propertyCode"
WHERE p."sourceFlag" = 'AGENT_SOURCED'
  AND p."sourcingApproved" = FALSE;

DELETE FROM "Property"
WHERE "sourceFlag" = 'AGENT_SOURCED'
  AND "sourcingApproved" = FALSE;

UPDATE "UnitSubmission" us
SET "propertySubmissionId" = m.new_submission_id,
    "propertyId"           = NULL
FROM _property_to_submission m
WHERE us."propertyId" = m.old_property_id;

-- Step 6: Drop dead columns from Unit and Property.
--
-- Drop partial indexes first because they reference columns we are about to
-- drop (sourceFlag, sourcingApproved, sourcingCancelled, pendingChanges).

DROP INDEX IF EXISTS "Unit_sourcingAgent_listingStatus_idx";
DROP INDEX IF EXISTS "Unit_pendingChanges_partial_idx";
DROP INDEX IF EXISTS "Unit_organizationId_propertyId_occupancyStatus_idx";

ALTER TABLE "Unit"
  DROP COLUMN "sourceFlag",
  DROP COLUMN "sourcingApproved",
  DROP COLUMN "sourcingApprovedById",
  DROP COLUMN "sourcingApprovedAt",
  DROP COLUMN "sourcingAmendmentNote",
  DROP COLUMN "sourcingCancelled",
  DROP COLUMN "pendingChanges",
  DROP COLUMN "pendingChangesSubmittedAt",
  DROP COLUMN "pendingChangesSubmittedById",
  DROP COLUMN "bedrooms",
  DROP COLUMN "bathrooms",
  DROP COLUMN "floorArea",
  DROP COLUMN "floor",
  DROP COLUMN "facing",
  DROP COLUMN "furnishingLevel",
  DROP COLUMN "sizeSqft",
  DROP COLUMN "amenities",
  DROP COLUMN "highlights",
  DROP COLUMN "publishedDescription",
  DROP COLUMN "publishedTitle",
  DROP COLUMN "photoKeys",
  DROP COLUMN "coverPhotoKey",
  DROP COLUMN "videoKeys",
  DROP COLUMN "propertyId",
  DROP COLUMN "buildingId",
  DROP COLUMN "unitCode";

ALTER TABLE "Unit" RENAME COLUMN "unitType" TO "listingType";

ALTER TABLE "Unit" DROP CONSTRAINT IF EXISTS "Unit_organizationId_propertyId_unitCode_unitType_key";
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_apartmentId_listingType_key" UNIQUE ("apartmentId", "listingType");

CREATE INDEX IF NOT EXISTS "Unit_apartmentId_listingStatus_idx" ON "Unit"("apartmentId", "listingStatus");
CREATE INDEX IF NOT EXISTS "Unit_organizationId_sourcingAgentId_idx" ON "Unit"("organizationId", "sourcingAgentId");

ALTER TABLE "Property"
  DROP COLUMN "sourceFlag",
  DROP COLUMN "sourcingAgentId",
  DROP COLUMN "sourcingApproved",
  DROP COLUMN "sourcingApprovedById",
  DROP COLUMN "sourcingApprovedAt",
  DROP COLUMN "sourcingAmendmentNote",
  DROP COLUMN "sourcingCancelled";

DROP INDEX IF EXISTS "Property_organizationId_sourcingAgentId_sourcingApproved_idx";

-- Step 7: Drop UnitListingModeTransition.
DROP TABLE IF EXISTS "UnitListingModeTransition";

-- Step 8: Drop the UnitSource enum if unused.
DROP TYPE IF EXISTS "UnitSource";

-- Step 9: Foreign keys for UnitSubmission + PropertySubmission.

ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_propertySubmissionId_fkey"
  FOREIGN KEY ("propertySubmissionId") REFERENCES "PropertySubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_sourcingAgentId_fkey"
  FOREIGN KEY ("sourcingAgentId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UnitSubmission" ADD CONSTRAINT "UnitSubmission_approvedListingId_fkey"
  FOREIGN KEY ("approvedListingId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PropertySubmission" ADD CONSTRAINT "PropertySubmission_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertySubmission" ADD CONSTRAINT "PropertySubmission_sourcingAgentId_fkey"
  FOREIGN KEY ("sourcingAgentId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PropertySubmission" ADD CONSTRAINT "PropertySubmission_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PropertySubmission" ADD CONSTRAINT "PropertySubmission_approvedPropertyId_fkey"
  FOREIGN KEY ("approvedPropertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 10: Drop the scratch temp table used in Step 5.5. Not using
-- `ON COMMIT DROP` because Prisma's shadow-DB replay (`prisma migrate dev`)
-- can split a migration file across multiple transactions, which would drop
-- the temp table before the statements at Step 6+ finish reading from the
-- same session — breaking a from-scratch shadow replay (P3006/P1014). An
-- explicit DROP TABLE at the very end is equivalent for a fresh database and
-- is a no-op on already-applied databases (they never re-run this file).
DROP TABLE IF EXISTS "_property_to_submission";
