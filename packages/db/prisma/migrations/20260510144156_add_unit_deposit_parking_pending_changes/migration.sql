-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "accessCardDepositPerPcs" DECIMAL(8,2),
ADD COLUMN     "accessCardQuantity" INTEGER,
ADD COLUMN     "parkingNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "parkingQuantity" INTEGER,
ADD COLUMN     "pendingChanges" JSONB,
ADD COLUMN     "pendingChangesSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "pendingChangesSubmittedById" UUID,
ADD COLUMN     "utilitiesDepositMonths" DECIMAL(4,2);

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_pendingChangesSubmittedById_fkey" FOREIGN KEY ("pendingChangesSubmittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Unit_sourcingAgent_listingStatus_idx"
  ON "Unit" ("sourcingAgentId", "sourcingApproved")
  WHERE "sourceFlag" = 'AGENT_SOURCED' AND "sourcingCancelled" = false;

CREATE INDEX "Unit_pendingChanges_partial_idx"
  ON "Unit" ("organizationId")
  WHERE "pendingChanges" IS NOT NULL;
