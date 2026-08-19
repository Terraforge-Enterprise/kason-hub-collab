-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "sprintId" UUID;

-- CreateTable
CREATE TABLE "Sprint" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT,
    "goal" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedCount" INTEGER,
    "carriedOverCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sprint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sprint_organizationId_status_idx" ON "Sprint"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Sprint_organizationId_seq_key" ON "Sprint"("organizationId", "seq");

-- CreateIndex
CREATE INDEX "Task_organizationId_sprintId_idx" ON "Task"("organizationId", "sprintId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security (mirrors phase2_foundation; CI guard requires per-table RLS in-migration).
-- Deny-all posture, no CREATE POLICY — the Hono API connects as the postgres superuser
-- (bypasses RLS); the anon/authenticated Supabase roles are denied.
ALTER TABLE "Sprint" ENABLE ROW LEVEL SECURITY;
