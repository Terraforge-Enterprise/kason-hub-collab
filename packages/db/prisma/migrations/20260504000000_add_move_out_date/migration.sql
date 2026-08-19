-- Add expected end-of-tenancy move-out date to commission claim items.
-- Nullable so existing rows do not need a backfill; required at the API
-- boundary for new submissions.
ALTER TABLE "CommissionClaimItem"
ADD COLUMN "moveOutDate" DATE;
