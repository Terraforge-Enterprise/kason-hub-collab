-- Recurring charges: definition + immutable effective-dated revisions + per-period custom
-- snapshot child + Charge line-provenance. ALL ADDITIVE (3 new tables, 1 new nullable column,
-- new indexes/FKs). No existing column or row is altered. Rollback = DROP the 3 tables +
-- DROP COLUMN "Charge"."sourceRecurringLineId".

-- CreateTable
CREATE TABLE "RecurringChargeDefinition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "apartmentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecurringChargeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringChargeRevision" (
    "id" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "bearer" TEXT NOT NULL,
    "categoryId" UUID,
    "effectiveFromMonth" DATE NOT NULL,
    "effectiveToMonth" DATE,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringChargeRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GridEntryRecurringLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "gridEntryId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "bearer" TEXT NOT NULL,
    "categoryId" UUID NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "categoryFamily" TEXT NOT NULL,
    "resolvedPartyId" UUID NOT NULL,
    "resolvedTenancyId" UUID,
    "resolvedUnitId" UUID NOT NULL,
    "effectiveMonth" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GridEntryRecurringLine_pkey" PRIMARY KEY ("id")
);

-- AlterTable (additive nullable column)
ALTER TABLE "Charge" ADD COLUMN "sourceRecurringLineId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "RecurringChargeDefinition_organizationId_apartmentId_code_key" ON "RecurringChargeDefinition"("organizationId", "apartmentId", "code");
CREATE INDEX "RecurringChargeDefinition_organizationId_apartmentId_idx" ON "RecurringChargeDefinition"("organizationId", "apartmentId");
CREATE INDEX "RecurringChargeRevision_definitionId_effectiveFromMonth_idx" ON "RecurringChargeRevision"("definitionId", "effectiveFromMonth");
CREATE UNIQUE INDEX "GridEntryRecurringLine_gridEntryId_definitionId_key" ON "GridEntryRecurringLine"("gridEntryId", "definitionId");
CREATE INDEX "GridEntryRecurringLine_organizationId_gridEntryId_idx" ON "GridEntryRecurringLine"("organizationId", "gridEntryId");
CREATE INDEX "Charge_organizationId_sourceRecurringLineId_idx" ON "Charge"("organizationId", "sourceRecurringLineId");

-- AddForeignKey
ALTER TABLE "RecurringChargeRevision" ADD CONSTRAINT "RecurringChargeRevision_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "RecurringChargeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GridEntryRecurringLine" ADD CONSTRAINT "GridEntryRecurringLine_gridEntryId_fkey" FOREIGN KEY ("gridEntryId") REFERENCES "UnitBillsGridEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_sourceRecurringLineId_fkey" FOREIGN KEY ("sourceRecurringLineId") REFERENCES "GridEntryRecurringLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
