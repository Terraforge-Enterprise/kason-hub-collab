-- CreateTable
CREATE TABLE "UnitMonthLedger" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "ownerPartyId" UUID,
    "incomeC" INTEGER NOT NULL DEFAULT 0,
    "deductibleExpensesC" INTEGER NOT NULL DEFAULT 0,
    "netPayoutC" INTEGER NOT NULL DEFAULT 0,
    "mgmtFeeC" INTEGER NOT NULL DEFAULT 0,
    "sstC" INTEGER NOT NULL DEFAULT 0,
    "sourceMaxUpdatedAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitMonthLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitMonthLedger_organizationId_periodMonth_idx" ON "UnitMonthLedger"("organizationId", "periodMonth");

-- CreateIndex
CREATE INDEX "UnitMonthLedger_ownerPartyId_periodMonth_idx" ON "UnitMonthLedger"("ownerPartyId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "UnitMonthLedger_organizationId_apartmentId_periodMonth_key" ON "UnitMonthLedger"("organizationId", "apartmentId", "periodMonth");

-- AddForeignKey
ALTER TABLE "UnitMonthLedger" ADD CONSTRAINT "UnitMonthLedger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
