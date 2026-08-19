-- CreateEnum
CREATE TYPE "IcSide" AS ENUM ('front', 'back');

-- AlterTable
ALTER TABLE "CommissionClaimItem" ADD COLUMN     "tenantIcBackKey" VARCHAR(500),
ADD COLUMN     "tenantIcFrontKey" VARCHAR(500);

-- CreateTable
CREATE TABLE "IcAccessLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimItemId" UUID NOT NULL,
    "side" "IcSide" NOT NULL,
    "viewerUserId" UUID NOT NULL,
    "viewerScope" VARCHAR(20) NOT NULL,
    "ip" VARCHAR(45),
    "userAgent" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IcAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingUpload" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "storageKey" VARCHAR(500) NOT NULL,
    "bucket" VARCHAR(50) NOT NULL,
    "uploadType" VARCHAR(30) NOT NULL,
    "side" "IcSide",
    "contentType" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "consumedClaimItemId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IcAccessLog_claimItemId_createdAt_idx" ON "IcAccessLog"("claimItemId", "createdAt");

-- CreateIndex
CREATE INDEX "IcAccessLog_organizationId_viewerUserId_createdAt_idx" ON "IcAccessLog"("organizationId", "viewerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "IcAccessLog_organizationId_createdAt_idx" ON "IcAccessLog"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingUpload_storageKey_key" ON "PendingUpload"("storageKey");

-- CreateIndex
CREATE INDEX "PendingUpload_status_expiresAt_idx" ON "PendingUpload"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PendingUpload_organizationId_partyId_createdAt_idx" ON "PendingUpload"("organizationId", "partyId", "createdAt");

-- CreateIndex
CREATE INDEX "PendingUpload_organizationId_status_updatedAt_idx" ON "PendingUpload"("organizationId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "IcAccessLog" ADD CONSTRAINT "IcAccessLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IcAccessLog" ADD CONSTRAINT "IcAccessLog_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "CommissionClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IcAccessLog" ADD CONSTRAINT "IcAccessLog_viewerUserId_fkey" FOREIGN KEY ("viewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingUpload" ADD CONSTRAINT "PendingUpload_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingUpload" ADD CONSTRAINT "PendingUpload_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingUpload" ADD CONSTRAINT "PendingUpload_consumedClaimItemId_fkey" FOREIGN KEY ("consumedClaimItemId") REFERENCES "CommissionClaimItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
