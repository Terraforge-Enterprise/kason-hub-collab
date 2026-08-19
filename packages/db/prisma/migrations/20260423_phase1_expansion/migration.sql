/*
  Warnings:

  - You are about to drop the column `description` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `ipAddress` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `userName` on the `AuditLog` table. All the data in the column will be lost.
  - Added the required column `actorRole` to the `AuditLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `actorUserId` to the `AuditLog` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UnitSource" AS ENUM ('COMPANY', 'AGENT_SOURCED');

-- CreateEnum
CREATE TYPE "VisibilityMode" AS ENUM ('PUBLIC', 'RESTRICTED');

-- DropIndex
DROP INDEX "AuditLog_organizationId_action_idx";

-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "description",
DROP COLUMN "ipAddress",
DROP COLUMN "metadata",
DROP COLUMN "userId",
DROP COLUMN "userName",
ADD COLUMN     "actorRole" TEXT NOT NULL,
ADD COLUMN     "actorUserId" UUID NOT NULL,
ADD COLUMN     "diff" JSONB,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "userAgent" TEXT,
ALTER COLUMN "entityId" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "hiddenFromPartyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "inChargeName" TEXT,
ADD COLUMN     "inChargePartyId" UUID,
ADD COLUMN     "moveInDate" TIMESTAMP(3),
ADD COLUMN     "readyNow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceFlag" "UnitSource" NOT NULL DEFAULT 'COMPANY',
ADD COLUMN     "sourcingAgentId" UUID,
ADD COLUMN     "sourcingApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourcingApprovedAt" TIMESTAMP(3),
ADD COLUMN     "sourcingApprovedById" UUID,
ADD COLUMN     "videoKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visibilityMode" "VisibilityMode" NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "ListingVisibilityGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingVisibilityGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantConsent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "textShown" TEXT NOT NULL,
    "primaryConsented" BOOLEAN NOT NULL,
    "aiProfilingConsent" BOOLEAN NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PdpaRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "requestType" TEXT NOT NULL,
    "submittedVia" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueBy" TIMESTAMP(3) NOT NULL,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledById" UUID,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "PdpaRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreachReport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    "reportedById" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "affectedParties" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "commissionerRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreachReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingVisibilityGrant_organizationId_unitId_idx" ON "ListingVisibilityGrant"("organizationId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingVisibilityGrant_unitId_partyId_key" ON "ListingVisibilityGrant"("unitId", "partyId");

-- CreateIndex
CREATE INDEX "TenantConsent_organizationId_tenancyId_idx" ON "TenantConsent"("organizationId", "tenancyId");

-- CreateIndex
CREATE INDEX "TenantConsent_organizationId_partyId_idx" ON "TenantConsent"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "PdpaRequest_organizationId_status_idx" ON "PdpaRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PdpaRequest_organizationId_dueBy_idx" ON "PdpaRequest"("organizationId", "dueBy");

-- CreateIndex
CREATE INDEX "BreachReport_organizationId_status_idx" ON "BreachReport"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BreachReport_organizationId_discoveredAt_idx" ON "BreachReport"("organizationId", "discoveredAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_actorUserId_createdAt_idx" ON "AuditLog"("organizationId", "actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_inChargePartyId_fkey" FOREIGN KEY ("inChargePartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_sourcingAgentId_fkey" FOREIGN KEY ("sourcingAgentId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_sourcingApprovedById_fkey" FOREIGN KEY ("sourcingApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVisibilityGrant" ADD CONSTRAINT "ListingVisibilityGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVisibilityGrant" ADD CONSTRAINT "ListingVisibilityGrant_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVisibilityGrant" ADD CONSTRAINT "ListingVisibilityGrant_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVisibilityGrant" ADD CONSTRAINT "ListingVisibilityGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PdpaRequest" ADD CONSTRAINT "PdpaRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PdpaRequest" ADD CONSTRAINT "PdpaRequest_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PdpaRequest" ADD CONSTRAINT "PdpaRequest_fulfilledById_fkey" FOREIGN KEY ("fulfilledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreachReport" ADD CONSTRAINT "BreachReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreachReport" ADD CONSTRAINT "BreachReport_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
