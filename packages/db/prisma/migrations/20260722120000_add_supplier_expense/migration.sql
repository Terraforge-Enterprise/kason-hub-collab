-- Accounting-document redesign P3 (2026-07-22): internal Expense (EXP-).
-- Two NEW tables: SupplierExpense (a supplier/property cost recorded once) +
-- SupplierExpenseAllocation (its split across who bears it: tenant|owner|kaen).
-- Purely additive + reversible: no existing table altered, zero rows written.

-- CreateTable
CREATE TABLE "SupplierExpense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "expenseNumber" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierRef" TEXT,
    "expenseDate" DATE NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "propertyId" UUID,
    "apartmentId" UUID,
    "unitId" UUID,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierExpenseAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierExpenseId" UUID NOT NULL,
    "borneBy" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "partyId" UUID,
    "tenancyId" UUID,
    "chargeCategoryId" UUID,
    "description" TEXT,
    "recoveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierExpenseAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierExpense_organizationId_expenseDate_idx" ON "SupplierExpense"("organizationId", "expenseDate");

-- CreateIndex
CREATE INDEX "SupplierExpense_organizationId_apartmentId_idx" ON "SupplierExpense"("organizationId", "apartmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierExpense_organizationId_expenseNumber_key" ON "SupplierExpense"("organizationId", "expenseNumber");

-- CreateIndex
CREATE INDEX "SupplierExpenseAllocation_organizationId_supplierExpenseId_idx" ON "SupplierExpenseAllocation"("organizationId", "supplierExpenseId");

-- CreateIndex
CREATE INDEX "SupplierExpenseAllocation_organizationId_borneBy_recoverySt_idx" ON "SupplierExpenseAllocation"("organizationId", "borneBy", "recoveryStatus");

-- AddForeignKey
ALTER TABLE "SupplierExpense" ADD CONSTRAINT "SupplierExpense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierExpenseAllocation" ADD CONSTRAINT "SupplierExpenseAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierExpenseAllocation" ADD CONSTRAINT "SupplierExpenseAllocation_supplierExpenseId_fkey" FOREIGN KEY ("supplierExpenseId") REFERENCES "SupplierExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS (hand-added on top of Prisma DDL; invisible to migrate diff, so no modeled drift).
-- Both tables are org-scoped + created after the 20260506 deny-all lockdown, so they MUST
-- enable RLS (deny-all default; the API 'postgres' role bypasses RLS). Mirrors
-- 20260720160000_phase2_owner_remittance. Required by scripts/check-new-tables-have-rls.ts.
ALTER TABLE "SupplierExpense"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierExpenseAllocation" ENABLE ROW LEVEL SECURITY;
