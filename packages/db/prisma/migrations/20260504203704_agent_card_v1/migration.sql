/*
  Warnings:

  - A unique constraint covering the columns `[activeCardVersionId]` on the table `Party` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "activeCardVersionId" UUID;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "coverPhotoKey" TEXT;

-- CreateTable
CREATE TABLE "OrganizationCardSettings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "brandName" TEXT,
    "brandTagline" TEXT,
    "agencyName" TEXT,
    "agencyLicense" TEXT,
    "agencyPhone" TEXT,
    "agencyFax" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "addressLine3" TEXT,
    "addressLine4" TEXT,
    "cardExpiryMonths" INTEGER NOT NULL DEFAULT 3,
    "isConfigured" BOOLEAN NOT NULL DEFAULT false,
    "logoKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationCardSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCardVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "status" TEXT NOT NULL,
    "submittedById" UUID NOT NULL,
    "submittedByType" TEXT NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "publicToken" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "reconfirmCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCardVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCardSettings_organizationId_key" ON "OrganizationCardSettings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCardVersion_publicToken_key" ON "AgentCardVersion"("publicToken");

-- CreateIndex
CREATE INDEX "AgentCardVersion_organizationId_status_idx" ON "AgentCardVersion"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AgentCardVersion_partyId_status_idx" ON "AgentCardVersion"("partyId", "status");

-- CreateIndex
CREATE INDEX "AgentCardVersion_publicToken_idx" ON "AgentCardVersion"("publicToken");

-- CreateIndex
CREATE INDEX "AgentCardVersion_status_expiresAt_idx" ON "AgentCardVersion"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Party_activeCardVersionId_key" ON "Party"("activeCardVersionId");

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_activeCardVersionId_fkey" FOREIGN KEY ("activeCardVersionId") REFERENCES "AgentCardVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationCardSettings" ADD CONSTRAINT "OrganizationCardSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCardVersion" ADD CONSTRAINT "AgentCardVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCardVersion" ADD CONSTRAINT "AgentCardVersion_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCardVersion" ADD CONSTRAINT "AgentCardVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCardVersion" ADD CONSTRAINT "AgentCardVersion_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Schema invariant 1: at most one (partyId, status='pending') row per party.
CREATE UNIQUE INDEX agent_card_one_pending_per_party
ON "AgentCardVersion" ("partyId")
WHERE "status" = 'pending';

-- Backfill: one settings row per existing org with isConfigured=false (gate prevents card creation until admin configures).
INSERT INTO "OrganizationCardSettings" ("id", "organizationId", "cardExpiryMonths", "isConfigured", "updatedAt")
SELECT gen_random_uuid(), o.id, 3, false, NOW()
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "OrganizationCardSettings" s WHERE s."organizationId" = o.id
);
