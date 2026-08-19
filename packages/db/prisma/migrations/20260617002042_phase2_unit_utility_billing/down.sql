-- Reverts phase2_unit_utility_billing. Run manually: psql "$DATABASE_URL" -f down.sql ; then DELETE its row from "_prisma_migrations".
ALTER TABLE "UtilityAllocation" DROP CONSTRAINT IF EXISTS "UtilityAllocation_tenancyId_fkey";
ALTER TABLE "UtilityAllocation" DROP CONSTRAINT IF EXISTS "UtilityAllocation_unitId_fkey";
ALTER TABLE "UtilityAllocation" DROP CONSTRAINT IF EXISTS "UtilityAllocation_billId_fkey";
ALTER TABLE "UtilityAllocation" DROP CONSTRAINT IF EXISTS "UtilityAllocation_organizationId_fkey";
ALTER TABLE "UnitUtilityBill" DROP CONSTRAINT IF EXISTS "UnitUtilityBill_apartmentId_fkey";
ALTER TABLE "UnitUtilityBill" DROP CONSTRAINT IF EXISTS "UnitUtilityBill_organizationId_fkey";
DROP TABLE IF EXISTS "UtilityAllocation";
DROP TABLE IF EXISTS "UnitUtilityBill";
