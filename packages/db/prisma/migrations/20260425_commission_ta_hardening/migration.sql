-- Commission + TA Hardening — 2026-04-25
-- 1. Add isCobroke flag on CommissionClaimItem (per-item; server-derived).
-- 2. Relax CommissionClaimItem.agentTierPercentage to nullable — drafts may have it unresolved.

BEGIN;

ALTER TABLE "CommissionClaimItem"
  ADD COLUMN "isCobroke" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CommissionClaimItem"
  ALTER COLUMN "agentTierPercentage" DROP NOT NULL;

COMMIT;
