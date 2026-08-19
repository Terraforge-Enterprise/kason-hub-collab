-- AlterTable
ALTER TABLE "GridMeterReading" ADD COLUMN     "updatedById" UUID;

-- NOTE: Prisma's differ also proposed `ALTER TABLE "Party" ALTER COLUMN
-- "idNumberNormalized" DROP DEFAULT;` here. That line is spurious and was
-- removed: idNumberNormalized is a raw-SQL `GENERATED ALWAYS ... STORED`
-- column (added in 20260706120000_party_id_number_normalized), which
-- Prisma's schema language cannot express, so schema.prisma declares it as
-- a plain `String?`. Prisma's differ perpetually misreads that gap as a
-- default needing removal, but the column has no default (Postgres
-- correctly rejects DROP DEFAULT on a generated column: 42601, hint DROP
-- EXPRESSION). Unrelated to this task's additive columns; left as
-- pre-existing drift for a future task to address deliberately (would need
-- @default mapping or accepted permanent drift in schema.prisma). Same
-- precedent as 20260710220119_tenancy_commission_fields and
-- 20260713160819_add_category_profit_expense_and_grid_expense_category.

-- AlterTable
ALTER TABLE "UnitBillsGridEntry" ADD COLUMN     "updatedById" UUID;
