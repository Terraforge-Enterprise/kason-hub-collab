-- AlterTable
ALTER TABLE "SalesUnit" ADD COLUMN     "sourcingCancelled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "sourcingCancelled" BOOLEAN NOT NULL DEFAULT false;
