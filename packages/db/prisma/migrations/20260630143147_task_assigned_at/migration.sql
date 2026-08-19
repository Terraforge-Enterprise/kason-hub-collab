ALTER TABLE "Task" ADD COLUMN "assignedAt" TIMESTAMP(3);

-- Backfill: best-effort assigned-time for already-assigned tasks = createdAt.
UPDATE "Task" SET "assignedAt" = "createdAt" WHERE "assigneeUserId" IS NOT NULL;
