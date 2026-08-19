-- Step 1: Rename ElectricityMeter → AircondMeter
-- Drop the FK from MeterReading → ElectricityMeter before renaming
ALTER TABLE "MeterReading" DROP CONSTRAINT "MeterReading_meterId_fkey";

-- Rename the table (preserves all data, indexes, PK)
ALTER TABLE "ElectricityMeter" RENAME TO "AircondMeter";

-- Rename the PK constraint
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "ElectricityMeter_pkey" TO "AircondMeter_pkey";

-- Rename the FK constraints on the renamed table
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "ElectricityMeter_organizationId_fkey" TO "AircondMeter_organizationId_fkey";
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "ElectricityMeter_unitId_fkey" TO "AircondMeter_unitId_fkey";

-- Rename the unique index
ALTER INDEX "ElectricityMeter_organizationId_unitId_key" RENAME TO "AircondMeter_organizationId_unitId_key";

-- Re-add the FK from MeterReading pointing to the renamed table
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "AircondMeter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Step 2: Add UtilityBillingMode enum
CREATE TYPE "UtilityBillingMode" AS ENUM ('SUBSIDY', 'NO_SUBSIDY');

-- Step 3: Add partitionBillingMode to Apartment
ALTER TABLE "Apartment" ADD COLUMN "partitionBillingMode" "UtilityBillingMode" NOT NULL DEFAULT 'NO_SUBSIDY';

-- Step 4: Create UtilityBillingConfig table
CREATE TABLE "UtilityBillingConfig" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subsidyPerPax" DECIMAL(12,2) NOT NULL DEFAULT 50.00,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtilityBillingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex on UtilityBillingConfig (per-org singleton)
CREATE UNIQUE INDEX "UtilityBillingConfig_organizationId_key" ON "UtilityBillingConfig"("organizationId");

-- AddForeignKey for UtilityBillingConfig
ALTER TABLE "UtilityBillingConfig" ADD CONSTRAINT "UtilityBillingConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 5: Rework UnitUtilityBill columns
-- Drop removed columns
ALTER TABLE "UnitUtilityBill" DROP COLUMN "method";
ALTER TABLE "UnitUtilityBill" DROP COLUMN "tnbTotalKwh";

-- Rename ownerAttributableElectricity → ownerAttributableAircond
ALTER TABLE "UnitUtilityBill" RENAME COLUMN "ownerAttributableElectricity" TO "ownerAttributableAircond";

-- Add new columns
ALTER TABLE "UnitUtilityBill" ADD COLUMN "billingMode" TEXT NOT NULL DEFAULT 'no_subsidy';
ALTER TABLE "UnitUtilityBill" ADD COLUMN "subsidyPerPax" DECIMAL(12,2);
ALTER TABLE "UnitUtilityBill" ADD COLUMN "subsidyCovered" DECIMAL(12,2);
ALTER TABLE "UnitUtilityBill" ADD COLUMN "ownerBorneUtilitiesTotal" DECIMAL(12,2);

-- Remove the NOT NULL default on billingMode (it's already seeded; don't keep a misleading default)
ALTER TABLE "UnitUtilityBill" ALTER COLUMN "billingMode" DROP DEFAULT;

-- Step 6: Add wifiShare and subsidyDeduction to UtilityAllocation
ALTER TABLE "UtilityAllocation" ADD COLUMN "wifiShare" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "UtilityAllocation" ADD COLUMN "subsidyDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Step 7: Enable RLS on new table
ALTER TABLE "UtilityBillingConfig" ENABLE ROW LEVEL SECURITY;

-- Step 8: Data-migrate existing tenant aircond charges (dev-only)
UPDATE "Charge" SET "chargeType" = 'aircond' WHERE "chargeType" = 'electricity';
