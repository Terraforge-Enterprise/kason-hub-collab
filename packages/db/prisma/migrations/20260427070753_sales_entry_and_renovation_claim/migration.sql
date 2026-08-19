-- AlterTable
ALTER TABLE "Tenancy" ADD COLUMN     "renovationClaimId" UUID;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "salesUnitOriginId" UUID;

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "developer" TEXT NOT NULL,
    "city" TEXT,
    "expectedHandover" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "promotedPropertyId" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesUnit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "salesDate" TIMESTAMP(3) NOT NULL,
    "purpose" TEXT NOT NULL,
    "bedrooms" INTEGER NOT NULL,
    "bathrooms" INTEGER NOT NULL,
    "parkingLots" INTEGER NOT NULL DEFAULT 0,
    "expectedRental" DECIMAL(12,2),
    "purchasePrice" DECIMAL(14,2) NOT NULL,
    "agentPartyId" UUID NOT NULL,
    "inChargePartyId" UUID,
    "sourceFlag" TEXT NOT NULL DEFAULT 'AGENT_SOURCED',
    "sourcingApproved" BOOLEAN NOT NULL DEFAULT false,
    "sourcingApprovedById" UUID,
    "sourcingApprovedAt" TIMESTAMP(3),
    "amendmentNotes" TEXT,
    "promotedUnitId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationProgress" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "salesUnitId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "startDate" TIMESTAMP(3),
    "expectedCompletion" TIMESTAMP(3),
    "actualCompletion" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "RenovationProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "progressId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "RenovationTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationPackage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "defaultPrice" DECIMAL(14,2) NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenovationPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationPackageSplit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "splitType" TEXT NOT NULL,
    "splitValue" DECIMAL(10,2) NOT NULL,
    "isHouseKeep" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RenovationPackageSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationClaim" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "salesUnitId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "packagePrice" DECIMAL(14,2) NOT NULL,
    "paymentType" TEXT NOT NULL,
    "monthlyOffsetAmount" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" UUID NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "reviewerNote" TEXT,

    CONSTRAINT "RenovationClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationClaimSplit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "partyPartyId" UUID,
    "partyDisplayName" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "splitType" TEXT NOT NULL,
    "splitValue" DECIMAL(10,2) NOT NULL,
    "isHouseKeep" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RenovationClaimSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationClaimDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" UUID NOT NULL,

    CONSTRAINT "RenovationClaimDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationClaimTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "RenovationClaimTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenovationClaimOffset" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "paymentId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RenovationClaimOffset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesClaim" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "salesUnitId" UUID NOT NULL,
    "commissionType" TEXT NOT NULL,
    "commissionValue" DECIMAL(10,2) NOT NULL,
    "computedAmount" DECIMAL(14,2) NOT NULL,
    "paymentType" TEXT NOT NULL DEFAULT 'full',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" UUID NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "reviewerNote" TEXT,

    CONSTRAINT "SalesClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesClaimSplit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "partyPartyId" UUID,
    "partyDisplayName" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "splitType" TEXT NOT NULL,
    "splitValue" DECIMAL(10,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SalesClaimSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesClaimTransition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "SalesClaimTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingsLabel" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SettingsLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_promotedPropertyId_key" ON "Project"("promotedPropertyId");

-- CreateIndex
CREATE INDEX "Project_organizationId_status_idx" ON "Project"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_name_key" ON "Project"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SalesUnit_promotedUnitId_key" ON "SalesUnit"("promotedUnitId");

-- CreateIndex
CREATE INDEX "SalesUnit_organizationId_agentPartyId_idx" ON "SalesUnit"("organizationId", "agentPartyId");

-- CreateIndex
CREATE INDEX "SalesUnit_organizationId_sourcingApproved_idx" ON "SalesUnit"("organizationId", "sourcingApproved");

-- CreateIndex
CREATE INDEX "SalesUnit_organizationId_salesDate_idx" ON "SalesUnit"("organizationId", "salesDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesUnit_organizationId_projectId_unitNumber_key" ON "SalesUnit"("organizationId", "projectId", "unitNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RenovationProgress_salesUnitId_key" ON "RenovationProgress"("salesUnitId");

-- CreateIndex
CREATE INDEX "RenovationProgress_organizationId_status_idx" ON "RenovationProgress"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RenovationTransition_progressId_changedAt_idx" ON "RenovationTransition"("progressId", "changedAt");

-- CreateIndex
CREATE INDEX "RenovationPackage_organizationId_archived_idx" ON "RenovationPackage"("organizationId", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "RenovationPackage_organizationId_key_key" ON "RenovationPackage"("organizationId", "key");

-- CreateIndex
CREATE INDEX "RenovationPackageSplit_packageId_idx" ON "RenovationPackageSplit"("packageId");

-- CreateIndex
CREATE INDEX "RenovationClaim_organizationId_status_idx" ON "RenovationClaim"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RenovationClaim_organizationId_submittedById_idx" ON "RenovationClaim"("organizationId", "submittedById");

-- CreateIndex
CREATE INDEX "RenovationClaim_organizationId_salesUnitId_idx" ON "RenovationClaim"("organizationId", "salesUnitId");

-- CreateIndex
CREATE INDEX "RenovationClaimSplit_claimId_idx" ON "RenovationClaimSplit"("claimId");

-- CreateIndex
CREATE INDEX "RenovationClaimDocument_claimId_idx" ON "RenovationClaimDocument"("claimId");

-- CreateIndex
CREATE INDEX "RenovationClaimTransition_claimId_changedAt_idx" ON "RenovationClaimTransition"("claimId", "changedAt");

-- CreateIndex
CREATE INDEX "RenovationClaimOffset_claimId_idx" ON "RenovationClaimOffset"("claimId");

-- CreateIndex
CREATE INDEX "RenovationClaimOffset_tenancyId_idx" ON "RenovationClaimOffset"("tenancyId");

-- CreateIndex
CREATE INDEX "SalesClaim_organizationId_status_idx" ON "SalesClaim"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SalesClaim_organizationId_salesUnitId_idx" ON "SalesClaim"("organizationId", "salesUnitId");

-- CreateIndex
CREATE INDEX "SalesClaimSplit_claimId_idx" ON "SalesClaimSplit"("claimId");

-- CreateIndex
CREATE INDEX "SalesClaimTransition_claimId_changedAt_idx" ON "SalesClaimTransition"("claimId", "changedAt");

-- CreateIndex
CREATE INDEX "SettingsLabel_organizationId_category_idx" ON "SettingsLabel"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "SettingsLabel_organizationId_category_key_key" ON "SettingsLabel"("organizationId", "category", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_salesUnitOriginId_key" ON "Unit"("salesUnitOriginId");

-- AddForeignKey
ALTER TABLE "Tenancy" ADD CONSTRAINT "Tenancy_renovationClaimId_fkey" FOREIGN KEY ("renovationClaimId") REFERENCES "RenovationClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_promotedPropertyId_fkey" FOREIGN KEY ("promotedPropertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_ownerPartyId_fkey" FOREIGN KEY ("ownerPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_inChargePartyId_fkey" FOREIGN KEY ("inChargePartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesUnit" ADD CONSTRAINT "SalesUnit_promotedUnitId_fkey" FOREIGN KEY ("promotedUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationProgress" ADD CONSTRAINT "RenovationProgress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationProgress" ADD CONSTRAINT "RenovationProgress_salesUnitId_fkey" FOREIGN KEY ("salesUnitId") REFERENCES "SalesUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationTransition" ADD CONSTRAINT "RenovationTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationTransition" ADD CONSTRAINT "RenovationTransition_progressId_fkey" FOREIGN KEY ("progressId") REFERENCES "RenovationProgress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationPackage" ADD CONSTRAINT "RenovationPackage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationPackageSplit" ADD CONSTRAINT "RenovationPackageSplit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationPackageSplit" ADD CONSTRAINT "RenovationPackageSplit_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "RenovationPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaim" ADD CONSTRAINT "RenovationClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaim" ADD CONSTRAINT "RenovationClaim_salesUnitId_fkey" FOREIGN KEY ("salesUnitId") REFERENCES "SalesUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaim" ADD CONSTRAINT "RenovationClaim_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "RenovationPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimSplit" ADD CONSTRAINT "RenovationClaimSplit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimSplit" ADD CONSTRAINT "RenovationClaimSplit_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "RenovationClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimSplit" ADD CONSTRAINT "RenovationClaimSplit_partyPartyId_fkey" FOREIGN KEY ("partyPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimDocument" ADD CONSTRAINT "RenovationClaimDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimDocument" ADD CONSTRAINT "RenovationClaimDocument_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "RenovationClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimTransition" ADD CONSTRAINT "RenovationClaimTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimTransition" ADD CONSTRAINT "RenovationClaimTransition_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "RenovationClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimOffset" ADD CONSTRAINT "RenovationClaimOffset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimOffset" ADD CONSTRAINT "RenovationClaimOffset_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "RenovationClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimOffset" ADD CONSTRAINT "RenovationClaimOffset_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenovationClaimOffset" ADD CONSTRAINT "RenovationClaimOffset_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaim" ADD CONSTRAINT "SalesClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaim" ADD CONSTRAINT "SalesClaim_salesUnitId_fkey" FOREIGN KEY ("salesUnitId") REFERENCES "SalesUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimSplit" ADD CONSTRAINT "SalesClaimSplit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimSplit" ADD CONSTRAINT "SalesClaimSplit_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "SalesClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimSplit" ADD CONSTRAINT "SalesClaimSplit_partyPartyId_fkey" FOREIGN KEY ("partyPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimTransition" ADD CONSTRAINT "SalesClaimTransition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesClaimTransition" ADD CONSTRAINT "SalesClaimTransition_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "SalesClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingsLabel" ADD CONSTRAINT "SettingsLabel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
