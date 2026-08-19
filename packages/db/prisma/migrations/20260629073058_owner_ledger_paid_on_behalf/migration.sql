-- Paid-on-behalf metadata (Task 9) — DISPLAY-ONLY, additive nullable columns.
-- When KAEN settles an owner expense (e.g. fire insurance) on the owner's behalf,
-- the admin can attach who was paid (payeeName), a supplier reference
-- (paidOnBehalfRef), and the payment date (paidOnBehalfDate). These flow:
--   statement Charge → owner-ledger.sync (source-2) → OwnerLedgerEntry → statement/receipt render.
-- They are DISPLAY-ONLY: they NEVER affect any money math (the expense already
-- deducts from the payout via the Task-8 adjustment path). Additive + nullable, so
-- existing rows backfill to NULL and no existing behaviour changes.

-- AlterTable
ALTER TABLE "Charge" ADD COLUMN     "paidOnBehalfDate" DATE,
ADD COLUMN     "paidOnBehalfRef" TEXT,
ADD COLUMN     "payeeName" TEXT;

-- AlterTable
ALTER TABLE "OwnerLedgerEntry" ADD COLUMN     "paidOnBehalfDate" DATE,
ADD COLUMN     "paidOnBehalfRef" TEXT,
ADD COLUMN     "payeeName" TEXT;
