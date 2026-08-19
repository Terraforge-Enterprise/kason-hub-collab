-- 20260425_restore_tatier_rentalmax
--
-- Restore the `rentalMax` column on TaTier (nullable) so admins can express
-- closed rental bands (e.g. Tier 2: RM2,001 – RM3,000 → RM324). NULL means
-- the band is open-ended (highest tier catches everything above its
-- rentalMin).
--
-- Safe to re-run (IF NOT EXISTS). No data is copied — existing rows keep
-- rentalMax NULL until an admin sets it via the seed or UI.

ALTER TABLE "TaTier"
  ADD COLUMN IF NOT EXISTS "rentalMax" DECIMAL(12, 2);
