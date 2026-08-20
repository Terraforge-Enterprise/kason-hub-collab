ALTER TABLE "GridExpense"
  ADD COLUMN "actualCost" DECIMAL(12,2),
  ADD COLUMN "costVendor" TEXT,
  ADD COLUMN "costPaymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
  ADD COLUMN "costPaymentDate" DATE,
  ADD COLUMN "costPaymentAccount" TEXT,
  ADD COLUMN "costNotes" TEXT;

ALTER TABLE "GridExpense"
  ADD CONSTRAINT "GridExpense_costPaymentStatus_check"
  CHECK ("costPaymentStatus" IN ('unpaid', 'partial', 'paid'));
