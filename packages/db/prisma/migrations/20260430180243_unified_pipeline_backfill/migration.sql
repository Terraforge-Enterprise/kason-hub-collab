-- ============================================================
-- Unified Pipeline Backfill Migration
-- ============================================================
-- This migration backfills data needed by the schema additions
-- in the previous unified_pipeline migration. Runs in 5 steps:
-- 1. Backfill Project.verifiedAt + verifiedById for existing rows.
-- 2. Per-org seed of 7 default RenovationStage rows.
-- 3. Per-org seed of one SalesClaimDefault (catch-all) + its split.
-- 4. Backfill RenovationStageProgress for legacy completed renovations,
--    in chunks of 1000 to avoid lock-table-bloat.
-- ============================================================

-- 1. Backfill Project.verifiedAt + verifiedById.
-- Existing rows are grandfathered as 'active' with verifiedAt=createdAt.
-- (Status was already 'active' before this migration; new default 'unverified'
-- only applies to future inserts.)
UPDATE "Project"
SET
  "verifiedAt" = "createdAt",
  "verifiedById" = COALESCE("createdById", (
    SELECT id FROM "User" WHERE email LIKE '%@kasonhub.system' LIMIT 1
  ))
WHERE "verifiedAt" IS NULL;

-- 2. Per-org seed: 7 default RenovationStage rows.
INSERT INTO "RenovationStage" ("id", "organizationId", "key", "label", "sortOrder", "archived", "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  o."id",
  s."key",
  s."label",
  s."sortOrder",
  false,
  NOW(),
  NOW()
FROM "Organization" o
CROSS JOIN (VALUES
  ('demo', 'Demolition', 1),
  ('wiring', 'Wiring & Electrical', 2),
  ('plumbing', 'Plumbing', 3),
  ('plastering', 'Plastering', 4),
  ('tiling', 'Tiling & Flooring', 5),
  ('finishes', 'Paint & Finishes', 6),
  ('cleaning', 'Final Cleaning', 7)
) AS s("key", "label", "sortOrder")
WHERE NOT EXISTS (
  SELECT 1 FROM "RenovationStage" rs WHERE rs."organizationId" = o."id"
);

-- 3a. Per-org seed: one SalesClaimDefault row (catch-all, appliesTo='__catchall__').
-- Default: 2% commission, 'full' payment, 100% to "Sales Commission" role.
WITH inserted_defaults AS (
  INSERT INTO "SalesClaimDefault" ("id", "organizationId", "appliesTo", "commissionType", "commissionValue", "paymentType", "updatedAt")
  SELECT
    gen_random_uuid(),
    o."id",
    '__catchall__',
    'percent_of_purchase',
    2.00,
    'full',
    NOW()
  FROM "Organization" o
  WHERE NOT EXISTS (
    SELECT 1 FROM "SalesClaimDefault" d WHERE d."organizationId" = o."id" AND d."appliesTo" = '__catchall__'
  )
  RETURNING "id", "organizationId"
)
-- 3b. One default split per default: 100% Sales Commission.
INSERT INTO "SalesClaimDefaultSplit" ("id", "organizationId", "defaultId", "roleLabel", "splitType", "splitValue", "sortOrder")
SELECT
  gen_random_uuid(),
  d."organizationId",
  d."id",
  'Sales Commission',
  'percent',
  100.00,
  0
FROM inserted_defaults d;

-- 4. Backfill RenovationStageProgress for legacy completed renovations.
-- Process in chunks of 1000 progress rows. For each completed RenovationProgress
-- without any stage-progress rows, seed one stage-progress row per active stage,
-- all marked 'completed' with completedAt = COALESCE(actualCompletion, updatedAt).
DO $$
DECLARE
  v_batch_size CONSTANT INT := 1000;
  v_processed INT := 0;
BEGIN
  LOOP
    WITH eligible_progress AS (
      SELECT p."id" AS progress_id, p."organizationId" AS org_id,
             p."actualCompletion" AS completed_at, p."updatedAt" AS fallback_at
      FROM "RenovationProgress" p
      WHERE p."status" = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM "RenovationStageProgress" sp WHERE sp."progressId" = p."id"
        )
      LIMIT v_batch_size
    )
    INSERT INTO "RenovationStageProgress" ("id", "organizationId", "progressId", "stageId", "status", "completedAt")
    SELECT
      gen_random_uuid(),
      ep.org_id,
      ep.progress_id,
      s."id",
      'completed',
      COALESCE(ep.completed_at, ep.fallback_at)
    FROM eligible_progress ep
    JOIN "RenovationStage" s ON s."organizationId" = ep.org_id AND s."archived" = false;

    GET DIAGNOSTICS v_processed = ROW_COUNT;
    EXIT WHEN v_processed = 0;
  END LOOP;
END $$;
