-- Rollback for 20260720160000_bill_expenses_as_charges.
-- Constraint/index names verified against the actual Prisma-generated migration.sql
-- in this folder (not guessed).
ALTER TABLE "Charge" DROP CONSTRAINT IF EXISTS "Charge_sourceGridExpenseId_fkey";
DROP INDEX IF EXISTS "Charge_organizationId_sourceGridExpenseId_idx";
ALTER TABLE "Charge" DROP COLUMN IF EXISTS "sourceGridExpenseId";
ALTER TABLE "Charge" DROP COLUMN IF EXISTS "sstRate";
ALTER TABLE "GridExpense" DROP COLUMN IF EXISTS "tenancyId";
