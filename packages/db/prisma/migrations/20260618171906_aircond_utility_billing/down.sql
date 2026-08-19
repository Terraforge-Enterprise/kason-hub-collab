-- Reverts aircond_utility_billing. Run manually:
--   psql "$DATABASE_URL" -f down.sql
--   then DELETE FROM "_prisma_migrations" WHERE migration_name = '20260618171906_aircond_utility_billing';
--
-- WARNING: "method" and "tnbTotalKwh" are re-added as nullable (their original NOT NULL constraint
-- would fail on any rows created after the migration). Restore NOT NULL manually if needed.

-- Step 8 reverse: revert chargeType (data-only; omitted here — chargeType='aircond' may legitimately
-- exist from other sources; manual revert if needed via:
--   UPDATE "Charge" SET "chargeType" = 'electricity' WHERE "chargeType" = 'aircond';)

-- Step 7 reverse: disable RLS
ALTER TABLE "UtilityBillingConfig" DISABLE ROW LEVEL SECURITY;

-- Step 6 reverse: drop wifiShare and subsidyDeduction from UtilityAllocation
ALTER TABLE "UtilityAllocation" DROP COLUMN IF EXISTS "subsidyDeduction";
ALTER TABLE "UtilityAllocation" DROP COLUMN IF EXISTS "wifiShare";

-- Step 5 reverse: revert UnitUtilityBill
ALTER TABLE "UnitUtilityBill" DROP COLUMN IF EXISTS "ownerBorneUtilitiesTotal";
ALTER TABLE "UnitUtilityBill" DROP COLUMN IF EXISTS "subsidyCovered";
ALTER TABLE "UnitUtilityBill" DROP COLUMN IF EXISTS "subsidyPerPax";
ALTER TABLE "UnitUtilityBill" DROP COLUMN IF EXISTS "billingMode";
ALTER TABLE "UnitUtilityBill" RENAME COLUMN "ownerAttributableAircond" TO "ownerAttributableElectricity";
ALTER TABLE "UnitUtilityBill" ADD COLUMN "tnbTotalKwh" DECIMAL(12,2);
ALTER TABLE "UnitUtilityBill" ADD COLUMN "method" TEXT;

-- Step 4 reverse: drop UtilityBillingConfig
ALTER TABLE "UtilityBillingConfig" DROP CONSTRAINT IF EXISTS "UtilityBillingConfig_organizationId_fkey";
DROP TABLE IF EXISTS "UtilityBillingConfig";

-- Step 3 reverse: drop partitionBillingMode from Apartment
ALTER TABLE "Apartment" DROP COLUMN IF EXISTS "partitionBillingMode";

-- Step 2 reverse: drop UtilityBillingMode enum
DROP TYPE IF EXISTS "UtilityBillingMode";

-- Step 1 reverse: rename AircondMeter back to ElectricityMeter
ALTER TABLE "MeterReading" DROP CONSTRAINT IF EXISTS "MeterReading_meterId_fkey";
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "AircondMeter_organizationId_fkey" TO "ElectricityMeter_organizationId_fkey";
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "AircondMeter_unitId_fkey" TO "ElectricityMeter_unitId_fkey";
ALTER TABLE "AircondMeter" RENAME CONSTRAINT "AircondMeter_pkey" TO "ElectricityMeter_pkey";
ALTER INDEX "AircondMeter_organizationId_unitId_key" RENAME TO "ElectricityMeter_organizationId_unitId_key";
ALTER TABLE "AircondMeter" RENAME TO "ElectricityMeter";
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "ElectricityMeter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
