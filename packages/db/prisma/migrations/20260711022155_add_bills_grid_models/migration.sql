-- CreateTable
CREATE TABLE "UnitBillsGridEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "readingDate" DATE,
    "rental" DECIMAL(12,2),
    "cleaning" DECIMAL(12,2),
    "cleaningBearer" TEXT NOT NULL DEFAULT 'owner',
    "tnbTotalRaw" DECIMAL(12,2),
    "tnbPattern" TEXT NOT NULL DEFAULT 'recharged',
    "ownerBorneTnb" DECIMAL(12,2),
    "airSelangorRaw" DECIMAL(12,2),
    "airPattern" TEXT NOT NULL DEFAULT 'recharged',
    "ownerBorneAir" DECIMAL(12,2),
    "wifi" DECIMAL(12,2),
    "wifiBearer" TEXT NOT NULL DEFAULT 'owner',
    "maintenanceFee" DECIMAL(12,2),
    "maintenanceFeeBearer" TEXT NOT NULL DEFAULT 'owner',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "billedAt" TIMESTAMP(3),
    "lockedBy" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitBillsGridEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GridExpense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "bearer" TEXT NOT NULL DEFAULT 'tenant',
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "withSST" BOOLEAN NOT NULL DEFAULT false,
    "partyId" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GridExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GridMeterReading" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "listingId" UUID NOT NULL,
    "tenancyId" UUID,
    "partyId" UUID,
    "previousKwh" DECIMAL(12,2),
    "currentKwh" DECIMAL(12,2),
    "amount" DECIMAL(12,2),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GridMeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitBillsBearerConfig" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "tnbPattern" TEXT NOT NULL DEFAULT 'recharged',
    "airPattern" TEXT NOT NULL DEFAULT 'recharged',
    "cleaningBearer" TEXT NOT NULL DEFAULT 'owner',
    "wifiBearer" TEXT NOT NULL DEFAULT 'owner',
    "maintenanceFeeBearer" TEXT NOT NULL DEFAULT 'owner',
    "cleaningRecurringAmount" DECIMAL(12,2) NOT NULL DEFAULT 100,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitBillsBearerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GridAttachment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "periodMonth" DATE NOT NULL,
    "entryId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GridAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnitBillsGridEntry_organizationId_periodMonth_idx" ON "UnitBillsGridEntry"("organizationId", "periodMonth");

-- CreateIndex
CREATE INDEX "UnitBillsGridEntry_organizationId_paymentStatus_idx" ON "UnitBillsGridEntry"("organizationId", "paymentStatus");

-- CreateIndex
CREATE INDEX "UnitBillsGridEntry_organizationId_apartmentId_idx" ON "UnitBillsGridEntry"("organizationId", "apartmentId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitBillsGridEntry_organizationId_apartmentId_periodMonth_key" ON "UnitBillsGridEntry"("organizationId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE INDEX "GridExpense_organizationId_entryId_idx" ON "GridExpense"("organizationId", "entryId");

-- CreateIndex
CREATE INDEX "GridExpense_organizationId_apartmentId_periodMonth_idx" ON "GridExpense"("organizationId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE INDEX "GridExpense_organizationId_partyId_idx" ON "GridExpense"("organizationId", "partyId");

-- CreateIndex
CREATE INDEX "GridMeterReading_organizationId_entryId_idx" ON "GridMeterReading"("organizationId", "entryId");

-- CreateIndex
CREATE INDEX "GridMeterReading_organizationId_apartmentId_periodMonth_idx" ON "GridMeterReading"("organizationId", "apartmentId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "GridMeterReading_organizationId_entryId_listingId_key" ON "GridMeterReading"("organizationId", "entryId", "listingId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitBillsBearerConfig_organizationId_apartmentId_key" ON "UnitBillsBearerConfig"("organizationId", "apartmentId");

-- CreateIndex
CREATE INDEX "GridAttachment_organizationId_apartmentId_periodMonth_idx" ON "GridAttachment"("organizationId", "apartmentId", "periodMonth");

-- AddForeignKey
ALTER TABLE "UnitBillsGridEntry" ADD CONSTRAINT "UnitBillsGridEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitBillsGridEntry" ADD CONSTRAINT "UnitBillsGridEntry_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridExpense" ADD CONSTRAINT "GridExpense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridExpense" ADD CONSTRAINT "GridExpense_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "UnitBillsGridEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridMeterReading" ADD CONSTRAINT "GridMeterReading_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridMeterReading" ADD CONSTRAINT "GridMeterReading_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "UnitBillsGridEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitBillsBearerConfig" ADD CONSTRAINT "UnitBillsBearerConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitBillsBearerConfig" ADD CONSTRAINT "UnitBillsBearerConfig_apartmentId_fkey" FOREIGN KEY ("apartmentId") REFERENCES "Apartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridAttachment" ADD CONSTRAINT "GridAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridAttachment" ADD CONSTRAINT "GridAttachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "UnitBillsGridEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the postgres
-- superuser; RLS is defense-in-depth vs direct anon/authenticated access). Matches every
-- other Phase-2 table.
ALTER TABLE "UnitBillsGridEntry"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GridExpense"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GridMeterReading"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UnitBillsBearerConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GridAttachment"        ENABLE ROW LEVEL SECURITY;
