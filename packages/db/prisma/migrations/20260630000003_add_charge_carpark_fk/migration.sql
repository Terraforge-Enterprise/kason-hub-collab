-- AlterTable
ALTER TABLE "Charge" ADD COLUMN "carparkId" UUID;

-- CreateIndex
CREATE INDEX "Charge_organizationId_carparkId_idx" ON "Charge"("organizationId", "carparkId");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_carparkId_fkey" FOREIGN KEY ("carparkId") REFERENCES "Carpark"("id") ON DELETE SET NULL ON UPDATE CASCADE;
