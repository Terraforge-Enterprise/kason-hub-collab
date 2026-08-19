-- Reverts phase2_sprints (additive-only — no Task data loss; tasks just lose sprint membership).
-- Run manually: psql "$DATABASE_URL" -f down.sql ; then DELETE its row from "_prisma_migrations".
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_sprintId_fkey";
ALTER TABLE "Sprint" DROP CONSTRAINT IF EXISTS "Sprint_organizationId_fkey";
DROP INDEX IF EXISTS "Task_organizationId_sprintId_idx";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "sprintId";
DROP TABLE IF EXISTS "Sprint";
