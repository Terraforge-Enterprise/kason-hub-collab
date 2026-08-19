-- Accounting-document redesign P6 (2026-07-22): KAEN operating-expense ledger.
-- One NEW table: KaenOperatingExpense — the agency's own P&L (software subscriptions,
-- office rent, bank charges, etc.), never owner/tenant money. Routed here from
-- borneBy="kaen" SupplierExpenseAllocation rows (P3) by expenses.service.ts when
-- ENABLE_KAEN_OPEX is on. Purely additive + reversible: no existing table altered,
-- zero rows written.

-- CreateTable
CREATE TABLE "KaenOperatingExpense" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceExpenseAllocationId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "expenseDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KaenOperatingExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KaenOperatingExpense_organizationId_expenseDate_idx" ON "KaenOperatingExpense"("organizationId", "expenseDate");

-- CreateIndex
CREATE INDEX "KaenOperatingExpense_organizationId_category_idx" ON "KaenOperatingExpense"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "KaenOperatingExpense_organizationId_sourceExpenseAllocation_key" ON "KaenOperatingExpense"("organizationId", "sourceExpenseAllocationId");

-- AddForeignKey
ALTER TABLE "KaenOperatingExpense" ADD CONSTRAINT "KaenOperatingExpense_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KaenOperatingExpense" ADD CONSTRAINT "KaenOperatingExpense_sourceExpenseAllocationId_fkey" FOREIGN KEY ("sourceExpenseAllocationId") REFERENCES "SupplierExpenseAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (hand-added on top of Prisma DDL; invisible to migrate diff, so no modeled drift).
-- Org-scoped + created after the 20260506 deny-all lockdown, so it MUST enable RLS
-- (deny-all default; the API 'postgres' role bypasses RLS). Mirrors
-- 20260722120000_add_supplier_expense. Required by scripts/check-new-tables-have-rls.ts.
ALTER TABLE "KaenOperatingExpense" ENABLE ROW LEVEL SECURITY;

