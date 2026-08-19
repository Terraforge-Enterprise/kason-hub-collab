/*
  Warnings:

  - You are about to drop the `BreachReport` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PdpaRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TenantConsent` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `propertyId` on table `CommissionClaimItem` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "BreachReport" DROP CONSTRAINT "BreachReport_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "BreachReport" DROP CONSTRAINT "BreachReport_reportedById_fkey";

-- DropForeignKey
ALTER TABLE "CommissionClaimItem" DROP CONSTRAINT "CommissionClaimItem_propertyId_fkey";

-- DropForeignKey
ALTER TABLE "PdpaRequest" DROP CONSTRAINT "PdpaRequest_fulfilledById_fkey";

-- DropForeignKey
ALTER TABLE "PdpaRequest" DROP CONSTRAINT "PdpaRequest_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "PdpaRequest" DROP CONSTRAINT "PdpaRequest_partyId_fkey";

-- DropForeignKey
ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_partyId_fkey";

-- DropForeignKey
ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_tenancyId_fkey";

-- AlterTable
ALTER TABLE "AgentLevelThreshold" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CommissionClaimItem" ADD COLUMN     "tenantEmail" VARCHAR(254),
ADD COLUMN     "tenantInstagramHandle" VARCHAR(30),
ADD COLUMN     "tenantJobPosition" VARCHAR(200),
ADD COLUMN     "tenantLinkedinUrl" VARCHAR(500),
ADD COLUMN     "tenantPhone" VARCHAR(20),
ALTER COLUMN "propertyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TaTier" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- DropTable
DROP TABLE "BreachReport";

-- DropTable
DROP TABLE "PdpaRequest";

-- DropTable
DROP TABLE "TenantConsent";

-- AddForeignKey
ALTER TABLE "CommissionClaimItem" ADD CONSTRAINT "CommissionClaimItem_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CommissionClaimItem_group_key_idx" RENAME TO "CommissionClaimItem_organizationId_propertyId_unitCode_room_idx";
