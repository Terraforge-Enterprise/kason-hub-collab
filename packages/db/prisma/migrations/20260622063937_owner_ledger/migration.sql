-- CreateTable
CREATE TABLE "OwnerLedgerEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "listingId" UUID,
    "tenancyId" UUID,
    "statementMonth" DATE NOT NULL,
    "transactionDate" DATE NOT NULL,
    "direction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "remarks" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "sstAmount" DECIMAL(12,2),
    "paidBy" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'paid',
    "taxCategory" TEXT NOT NULL DEFAULT 'check_with_tax_agent',
    "includeInPayout" BOOLEAN NOT NULL DEFAULT true,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceChargeId" UUID,
    "sourceInvoiceId" UUID,
    "sourceUtilityBillId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerLedgerEntry_organizationId_ownerPartyId_statementMonth_idx" ON "OwnerLedgerEntry"("organizationId", "ownerPartyId", "statementMonth");

-- CreateIndex
CREATE INDEX "OwnerLedgerEntry_organizationId_propertyId_idx" ON "OwnerLedgerEntry"("organizationId", "propertyId");

-- CreateIndex
CREATE INDEX "OwnerLedgerEntry_organizationId_direction_category_idx" ON "OwnerLedgerEntry"("organizationId", "direction", "category");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerLedgerEntry_organizationId_sourceType_sourceChargeId_key" ON "OwnerLedgerEntry"("organizationId", "sourceType", "sourceChargeId");

-- AddForeignKey
ALTER TABLE "OwnerLedgerEntry" ADD CONSTRAINT "OwnerLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
