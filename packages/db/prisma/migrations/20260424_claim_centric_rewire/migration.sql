-- 20260424_claim_centric_rewire
-- Drops the Deal-era stack, simplifies TaTier, adds shortfall columns to
-- CommissionClaimItem and a supporting index.
--
-- Tolerant to missing tables (Supabase sequences run this AFTER creating
-- them via 20260423_commission_ta_engines, but the IF EXISTS guards keep
-- this robust). Single implicit transaction (Prisma default).

DO $$
DECLARE
  d_count bigint := 0;
  dp_count bigint := 0;
  ts_count bigint := 0;
  sf_count bigint := 0;
  cr_count bigint := 0;
  cc_with_deal bigint := 0;
BEGIN
  IF to_regclass('"Deal"') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM "Deal"' INTO d_count;
  END IF;
  IF to_regclass('"DealParty"') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM "DealParty"' INTO dp_count;
  END IF;
  IF to_regclass('"TaSplit"') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM "TaSplit"' INTO ts_count;
  END IF;
  IF to_regclass('"Shortfall"') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM "Shortfall"' INTO sf_count;
  END IF;
  IF to_regclass('"CommissionRule"') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM "CommissionRule"' INTO cr_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CommissionClaim' AND column_name = 'dealId'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM "CommissionClaim" WHERE "dealId" IS NOT NULL' INTO cc_with_deal;
  END IF;

  IF (d_count + dp_count + ts_count + sf_count + cr_count + cc_with_deal) > 0 THEN
    RAISE EXCEPTION 'Pre-flight failed: Deal=%, DealParty=%, TaSplit=%, Shortfall=%, CommissionRule=%, CommissionClaim.dealId!=NULL=%. Clean up before re-running migration.',
      d_count, dp_count, ts_count, sf_count, cr_count, cc_with_deal;
  END IF;
END$$;

-- Drop order: child → parent
DROP TABLE IF EXISTS "Shortfall"        CASCADE;
DROP TABLE IF EXISTS "TaSplit"          CASCADE;
DROP TABLE IF EXISTS "DealParty"        CASCADE;
DROP TABLE IF EXISTS "Deal"             CASCADE;
DROP TABLE IF EXISTS "CommissionRule"   CASCADE;

-- Drop Deal-related columns on CommissionClaim
ALTER TABLE "CommissionClaim"
  DROP COLUMN IF EXISTS "dealId",
  DROP COLUMN IF EXISTS "payoutRole",
  DROP COLUMN IF EXISTS "payoutAmount",
  DROP COLUMN IF EXISTS "shortfallApplied";

-- Simplify TaTier: drop rentalMax + effectiveFrom, add createdAt + updatedAt
ALTER TABLE "TaTier"
  DROP CONSTRAINT IF EXISTS "TaTier_organizationId_tier_effectiveFrom_key";

ALTER TABLE "TaTier"
  DROP COLUMN IF EXISTS "rentalMax",
  DROP COLUMN IF EXISTS "effectiveFrom";

ALTER TABLE "TaTier"
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Defensive dedupe before tightening the unique constraint:
-- Old unique was (organizationId, tier, effectiveFrom) so reseed-with-different-timestamps
-- could have produced multiple rows sharing (organizationId, tier). Keep the earliest
-- row per (org, tier) using ctid ordering (effectiveFrom was just dropped).
DELETE FROM "TaTier" a
USING "TaTier" b
WHERE a."organizationId" = b."organizationId"
  AND a.tier = b.tier
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS "TaTier_organizationId_tier_key"
  ON "TaTier"("organizationId", "tier");

CREATE INDEX IF NOT EXISTS "TaTier_organizationId_rentalMin_idx"
  ON "TaTier"("organizationId", "rentalMin");

-- Add 2 nullable columns to CommissionClaimItem for per-claim shortfall persistence
ALTER TABLE "CommissionClaimItem"
  ADD COLUMN IF NOT EXISTS "shortfallApplied"   DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "outstandingBalance" DECIMAL(12, 2);

-- Add supporting index for Deal-audit grouped query
CREATE INDEX IF NOT EXISTS "CommissionClaimItem_group_key_idx"
  ON "CommissionClaimItem"("organizationId", "propertyId", "unitCode", "roomType", "moveInDate");
