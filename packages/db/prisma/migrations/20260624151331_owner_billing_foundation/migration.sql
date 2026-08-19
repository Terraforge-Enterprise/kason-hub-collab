-- AlterTable
ALTER TABLE "Tenancy" ADD COLUMN     "reservationId" UUID;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "ownerPartyId" UUID;

-- AlterTable
ALTER TABLE "UnitReservation" ADD COLUMN     "agreedMonthlyRent" DECIMAL(12,2);

-- CreateIndex
CREATE UNIQUE INDEX "Tenancy_reservationId_key" ON "Tenancy"("reservationId");

-- CreateIndex
CREATE INDEX "Unit_organizationId_ownerPartyId_idx" ON "Unit"("organizationId", "ownerPartyId");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "UnitReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
