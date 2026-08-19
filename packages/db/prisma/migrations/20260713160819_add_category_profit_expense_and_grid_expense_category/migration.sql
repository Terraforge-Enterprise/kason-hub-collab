-- AlterTable
ALTER TABLE "ChargeCategory" ADD COLUMN     "profitExpense" TEXT;

-- AlterTable
ALTER TABLE "GridExpense" ADD COLUMN     "chargeCategoryId" UUID;

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
-- @default mapping or accepted permanent drift in schema.prisma).

-- CreateIndex
CREATE INDEX "GridExpense_organizationId_chargeCategoryId_idx" ON "GridExpense"("organizationId", "chargeCategoryId");

-- AddForeignKey
ALTER TABLE "GridExpense" ADD CONSTRAINT "GridExpense_chargeCategoryId_fkey" FOREIGN KEY ("chargeCategoryId") REFERENCES "ChargeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
