-- AlterTable
ALTER TABLE "RoomType" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PARTITION';

-- CreateTable
CREATE TABLE "UnitListingModeTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "unitCode" TEXT NOT NULL,
    "fromMode" TEXT,
    "toMode" TEXT NOT NULL,
    "archivedUnitIds" UUID[],
    "createdUnitId" UUID,
    "performedById" UUID NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitListingModeTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitListingModeTransition_organizationId_propertyId_unitCod_idx" ON "UnitListingModeTransition"("organizationId", "propertyId", "unitCode", "performedAt");

-- AddForeignKey
ALTER TABLE "UnitListingModeTransition" ADD CONSTRAINT "UnitListingModeTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
