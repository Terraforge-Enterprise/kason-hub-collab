-- Reconciliation, not a feature change. The hand-written 20260519202607
-- inventory_three_table_refactor created Apartment/PropertySubmission/
-- UnitSubmission with DB-side id defaults (gen_random_uuid(), used by its own
-- backfill INSERTs) and two hand-truncated index names. schema.prisma declares
-- client-side @default(uuid()) and standard index names, so every migrate dev
-- since then re-proposes these 5 statements. Verified benign 2026-06-11: zero
-- raw-SQL inserts rely on the DB defaults; renames are cosmetic.
-- User-approved as a separate migration so phase2_foundation stays purely additive.

ALTER TABLE "Apartment" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PropertySubmission" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "UnitSubmission" ALTER COLUMN "id" DROP DEFAULT;
ALTER INDEX "PropertySubmission_organizationId_sourcingAgentId_submissionSta" RENAME TO "PropertySubmission_organizationId_sourcingAgentId_submissio_idx";
ALTER INDEX "UnitSubmission_organizationId_sourcingAgentId_submissionState_i" RENAME TO "UnitSubmission_organizationId_sourcingAgentId_submissionSta_idx";
