-- AlterTable
ALTER TABLE "CommissionClaim" ADD COLUMN     "dealId" UUID,
ADD COLUMN     "payoutAmount" DECIMAL(12,2),
ADD COLUMN     "payoutRole" TEXT,
ADD COLUMN     "shortfallApplied" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Deal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "unitId" UUID,
    "tenancyId" UUID,
    "monthlyRental" DECIMAL(12,2) NOT NULL,
    "taFeeCollected" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taTier" INTEGER NOT NULL,
    "taCompanyMinimum" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealParty" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "dealId" UUID NOT NULL,
    "agentPartyId" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "sharePercent" DECIMAL(5,2) NOT NULL,
    "preLeaderPartyId" UUID,
    "leaderPartyId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaSplit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "dealId" UUID NOT NULL,
    "agentPartyId" UUID NOT NULL,
    "sharePercent" DECIMAL(5,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "TaSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shortfall" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "dealId" UUID NOT NULL,
    "agentPartyId" UUID NOT NULL,
    "shortfallAmount" DECIMAL(12,2) NOT NULL,
    "deductedFromCommission" DECIMAL(12,2) NOT NULL,
    "outstandingBalance" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "Shortfall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "agentPercent" DECIMAL(5,2) NOT NULL,
    "preLeaderPercent" DECIMAL(5,2) NOT NULL,
    "leaderPercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaTier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "rentalMin" DECIMAL(12,2) NOT NULL,
    "rentalMax" DECIMAL(12,2),
    "companyMinimum" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deal_organizationId_status_idx" ON "Deal"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Deal_organizationId_createdAt_idx" ON "Deal"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "DealParty_organizationId_dealId_idx" ON "DealParty"("organizationId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "DealParty_dealId_agentPartyId_side_key" ON "DealParty"("dealId", "agentPartyId", "side");

-- CreateIndex
CREATE UNIQUE INDEX "TaSplit_dealId_agentPartyId_key" ON "TaSplit"("dealId", "agentPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "Shortfall_dealId_agentPartyId_key" ON "Shortfall"("dealId", "agentPartyId");

-- CreateIndex
CREATE INDEX "CommissionRule_organizationId_side_effectiveFrom_idx" ON "CommissionRule"("organizationId", "side", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "TaTier_organizationId_tier_effectiveFrom_key" ON "TaTier"("organizationId", "tier", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "CommissionClaim" ADD CONSTRAINT "CommissionClaim_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_preLeaderPartyId_fkey" FOREIGN KEY ("preLeaderPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealParty" ADD CONSTRAINT "DealParty_leaderPartyId_fkey" FOREIGN KEY ("leaderPartyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaSplit" ADD CONSTRAINT "TaSplit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaSplit" ADD CONSTRAINT "TaSplit_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaSplit" ADD CONSTRAINT "TaSplit_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shortfall" ADD CONSTRAINT "Shortfall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shortfall" ADD CONSTRAINT "Shortfall_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shortfall" ADD CONSTRAINT "Shortfall_agentPartyId_fkey" FOREIGN KEY ("agentPartyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaTier" ADD CONSTRAINT "TaTier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
