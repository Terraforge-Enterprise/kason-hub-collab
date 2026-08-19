-- CreateTable
CREATE TABLE "UnitUtilityBill" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "tnbTotal" DECIMAL(12,2) NOT NULL,
    "tnbTotalKwh" DECIMAL(12,2),
    "airSelangor" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "indahWater" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cleaning" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "wifi" DECIMAL(12,2),
    "ownerAttributableElectricity" DECIMAL(12,2),
    "roundingResidual" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitUtilityBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilityAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "pax" INTEGER NOT NULL,
    "tnbShare" DECIMAL(12,2) NOT NULL,
    "airSelangorShare" DECIMAL(12,2) NOT NULL,
    "indahShare" DECIMAL(12,2) NOT NULL,
    "cleaningShare" DECIMAL(12,2) NOT NULL,
    "computedAmount" DECIMAL(12,2) NOT NULL,
    "chargeId" UUID,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtilityAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitUtilityBill_organizationId_status_idx" ON "UnitUtilityBill"("organizationId", "status");

-- CreateIndex
CREATE INDEX "UnitUtilityBill_organizationId_periodMonth_idx" ON "UnitUtilityBill"("organizationId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "UnitUtilityBill_organizationId_apartmentId_periodMonth_key" ON "UnitUtilityBill"("organizationId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE INDEX "UtilityAllocation_organizationId_billId_idx" ON "UtilityAllocation"("organizationId", "billId");

-- CreateIndex
CREATE UNIQUE INDEX "UtilityAllocation_organizationId_billId_unitId_key" ON "UtilityAllocation"("organizationId", "billId", "unitId");

-- AddForeignKey
ALTER TABLE "UnitUtilityBill" ADD CONSTRAINT "UnitUtilityBill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitUtilityBill" ADD CONSTRAINT "UnitUtilityBill_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityAllocation" ADD CONSTRAINT "UtilityAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityAllocation" ADD CONSTRAINT "UtilityAllocation_billId_fkey" FOREIGN KEY ("billId") REFERENCES "UnitUtilityBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityAllocation" ADD CONSTRAINT "UtilityAllocation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityAllocation" ADD CONSTRAINT "UtilityAllocation_tenancyId_fkey" FOREIGN KEY ("tenancyId") REFERENCES "Tenancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security (mirrors phase2_foundation; CI guard requires per-table RLS in-migration)
ALTER TABLE "UnitUtilityBill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UtilityAllocation" ENABLE ROW LEVEL SECURITY;

