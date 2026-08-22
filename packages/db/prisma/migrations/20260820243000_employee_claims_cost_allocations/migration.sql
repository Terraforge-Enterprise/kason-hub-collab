ALTER TABLE "SupplierExpense"
  ADD COLUMN "paymentSource" TEXT NOT NULL DEFAULT 'company_bank',
  ADD COLUMN "claimantName" TEXT,
  ADD COLUMN "costPurpose" TEXT NOT NULL DEFAULT 'unit_specific',
  ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN "reimbursementStatus" TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN "approvedById" UUID,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "notes" TEXT;

CREATE TABLE "SupplierExpenseCostAssignment" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "supplierExpenseId" UUID NOT NULL,
  "apartmentId" UUID NOT NULL,
  "gridExpenseId" UUID,
  "amount" DECIMAL(12,2) NOT NULL,
  "description" TEXT,
  "assignedById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierExpenseCostAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankCostAllocation" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "bankTransactionId" UUID NOT NULL,
  "supplierExpenseId" UUID,
  "gridExpenseId" UUID,
  "amount" DECIMAL(12,2) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankCostAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierExpenseCostAssignment_organizationId_supplierExpenseId_idx" ON "SupplierExpenseCostAssignment"("organizationId", "supplierExpenseId");
CREATE INDEX "SupplierExpenseCostAssignment_organizationId_apartmentId_idx" ON "SupplierExpenseCostAssignment"("organizationId", "apartmentId");
CREATE INDEX "BankCostAllocation_organizationId_bankTransactionId_idx" ON "BankCostAllocation"("organizationId", "bankTransactionId");
CREATE INDEX "BankCostAllocation_organizationId_supplierExpenseId_idx" ON "BankCostAllocation"("organizationId", "supplierExpenseId");
CREATE INDEX "BankCostAllocation_organizationId_gridExpenseId_idx" ON "BankCostAllocation"("organizationId", "gridExpenseId");

ALTER TABLE "SupplierExpenseCostAssignment" ADD CONSTRAINT "SupplierExpenseCostAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierExpenseCostAssignment" ADD CONSTRAINT "SupplierExpenseCostAssignment_supplierExpenseId_fkey" FOREIGN KEY ("supplierExpenseId") REFERENCES "SupplierExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankReconciliationTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_supplierExpenseId_fkey" FOREIGN KEY ("supplierExpenseId") REFERENCES "SupplierExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_gridExpenseId_fkey" FOREIGN KEY ("gridExpenseId") REFERENCES "GridExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_exactly_one_target_check"
  CHECK (("supplierExpenseId" IS NOT NULL)::int + ("gridExpenseId" IS NOT NULL)::int = 1);
ALTER TABLE "BankCostAllocation" ADD CONSTRAINT "BankCostAllocation_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "SupplierExpenseCostAssignment" ADD CONSTRAINT "SupplierExpenseCostAssignment_amount_positive_check" CHECK ("amount" > 0);
