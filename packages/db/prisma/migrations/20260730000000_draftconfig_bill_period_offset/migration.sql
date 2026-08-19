-- Advance billing: how many whole months AHEAD of the run month a draft run bills.
--
-- 1 (the default) = KAEN's process: the run day drafts the COMING month's rent.
-- 0 = the pre-2026-07 behaviour (draft the run month itself).
--
-- ADDITIVE + REVERSIBLE: a defaulted NOT NULL column on a table that is a per-org
-- singleton. No backfill needed and no row is rewritten in a way that changes money
-- (DraftConfig holds schedule policy only, never amounts).
--
-- Rollback: ALTER TABLE "DraftConfig" DROP COLUMN "billPeriodOffset";

ALTER TABLE "DraftConfig"
  ADD COLUMN "billPeriodOffset" INTEGER NOT NULL DEFAULT 1;

-- Bound the offset in the database too, not only in zod: a stray API client or a
-- manual psql UPDATE must not be able to schedule drafts years into the future.
ALTER TABLE "DraftConfig"
  ADD CONSTRAINT "DraftConfig_billPeriodOffset_range"
  CHECK ("billPeriodOffset" >= 0 AND "billPeriodOffset" <= 2);
