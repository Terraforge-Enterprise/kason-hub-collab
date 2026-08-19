-- CreateTable
CREATE TABLE "OwnerStatementPeriod" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "apartmentId" UUID,
    "periodMonth" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "issuedAt" TIMESTAMP(3),
    "openingBalanceC" INTEGER NOT NULL DEFAULT 0,
    "closingBalanceC" INTEGER NOT NULL DEFAULT 0,
    "netPayoutC" INTEGER NOT NULL DEFAULT 0,
    "snapshotJson" JSONB,
    "pdfKey" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "sourceMaxUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerStatementPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerStatementPeriod_organizationId_ownerPartyId_periodMont_idx" ON "OwnerStatementPeriod"("organizationId", "ownerPartyId", "periodMonth");

-- CreateIndex
CREATE INDEX "OwnerStatementPeriod_organizationId_apartmentId_periodMonth_idx" ON "OwnerStatementPeriod"("organizationId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerStatementPeriod_organizationId_ownerPartyId_apartmentI_key" ON "OwnerStatementPeriod"("organizationId", "ownerPartyId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerStatementPeriod_organizationId_idempotencyKey_key" ON "OwnerStatementPeriod"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "OwnerStatementPeriod" ADD CONSTRAINT "OwnerStatementPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
