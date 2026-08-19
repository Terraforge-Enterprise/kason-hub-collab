-- Bills-grid invoice link (Task 1) — additive nullable columns + one index + one FK.
-- Charge.sourceGridEntryId tags charges minted by the bills-grid Bill so re-Bill can
-- find live (ISSUED) invoices; UnitBillsGridEntry.invoicedAt is the grid read/lock
-- state. Both columns nullable, no backfill, no DEFAULT.
-- The FK Charge.sourceGridEntryId -> UnitBillsGridEntry(id) is ON DELETE SET NULL:
-- deleting a grid entry nulls the ref (never orphans it), so the re-Bill/double-count
-- logic (which locate live charges by sourceGridEntryId) stays correct. Reversible:
--   ALTER TABLE "Charge" DROP CONSTRAINT "Charge_sourceGridEntryId_fkey";
--   DROP INDEX "Charge_organizationId_sourceGridEntryId_idx";
--   ALTER TABLE "Charge" DROP COLUMN "sourceGridEntryId";
--   ALTER TABLE "UnitBillsGridEntry" DROP COLUMN "invoicedAt";

-- AlterTable
ALTER TABLE "Charge" ADD COLUMN     "sourceGridEntryId" UUID;

-- AlterTable
ALTER TABLE "UnitBillsGridEntry" ADD COLUMN     "invoicedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Charge_organizationId_sourceGridEntryId_idx" ON "Charge"("organizationId", "sourceGridEntryId");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_sourceGridEntryId_fkey" FOREIGN KEY ("sourceGridEntryId") REFERENCES "UnitBillsGridEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
