ALTER TABLE "Tenancy"
  ADD COLUMN "renewalDecision" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "renewalDecisionAt" TIMESTAMP(3),
  ADD COLUMN "renewalContactedAt" TIMESTAMP(3),
  ADD COLUMN "renewalNotes" TEXT;

CREATE INDEX "Tenancy_organizationId_status_renewalDecision_endDate_idx"
  ON "Tenancy"("organizationId", "status", "renewalDecision", "endDate");
