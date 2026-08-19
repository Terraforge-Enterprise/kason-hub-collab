-- C2: Deduplicate utility-sourced OwnerLedgerEntry rows and add a unique index
-- to prevent duplicates under concurrent same-(org,owner,month) sync calls.
--
-- Utility rows carry sourceChargeId=NULL, so the existing
--   @@unique([organizationId, sourceType, sourceChargeId])
-- treats each row as distinct (Postgres NULLs-distinct) → concurrent syncs can
-- write duplicates → owner-borne expense double-counted → owner underpaid.
--
-- Step 1: dedup existing rows — keep the lowest id per (org, sourceType, billId).
-- Step 2: create a unique index on the three-column key.
-- Additive-only: no existing column is dropped or renamed.

-- keep one row per (org, sourceType, sourceUtilityBillId) for utility rows, drop the rest
DELETE FROM "OwnerLedgerEntry" a USING "OwnerLedgerEntry" b
WHERE a."sourceUtilityBillId" IS NOT NULL
  AND a."sourceType" = b."sourceType"
  AND a."organizationId" = b."organizationId"
  AND a."sourceUtilityBillId" = b."sourceUtilityBillId"
  AND a.id > b.id;

CREATE UNIQUE INDEX "OwnerLedgerEntry_org_sourceType_sourceUtilityBillId_key"
  ON "OwnerLedgerEntry" ("organizationId", "sourceType", "sourceUtilityBillId");
