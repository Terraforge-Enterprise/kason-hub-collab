-- Bill-expenses-as-charges feature (spec R2/R3/R4): additive, nullable columns +
-- provenance FK. No existing column or row is altered. Flag-dark until later tasks
-- wire the read/write paths. Rollback = down.sql in this migration folder.

-- AlterTable
ALTER TABLE "Charge" ADD COLUMN     "sourceGridExpenseId" UUID,
ADD COLUMN     "sstRate" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "GridExpense" ADD COLUMN     "tenancyId" UUID;

-- CreateIndex
CREATE INDEX "Charge_organizationId_sourceGridExpenseId_idx" ON "Charge"("organizationId", "sourceGridExpenseId");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_sourceGridExpenseId_fkey" FOREIGN KEY ("sourceGridExpenseId") REFERENCES "GridExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
