-- TA Share Percent — 2026-04-25
-- Adds per-item TA share column, nullable (null = solo or listing-side).

BEGIN;

ALTER TABLE "CommissionClaimItem"
  ADD COLUMN "taSharePercent" NUMERIC(5, 2);

COMMIT;
