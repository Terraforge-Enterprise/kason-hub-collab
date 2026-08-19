-- Spec 1 Phase-2 owner remittance / receivable-offset / reversal / idempotency.
-- Additive, nullable columns on OwnerLedgerEntry + two new allocation join tables.
-- Forward-only; no backfill; every new column nullable; no existing row is touched.
-- Mirrors the Phase-1 additive pattern (20260720150000_phase2_rent_reclassification_columns)
-- for the ALTER TABLE, and the CreateTable/CreateIndex/AddForeignKey convention used by
-- 20260719000000_add_owner_statement_period / 20260711022155_add_bills_grid_models for
-- the two new tables. Statement bodies generated via `prisma migrate diff` against this
-- schema (canonical column types + 63-byte-safe truncated index/constraint names), with
-- every unrelated drop/rename proposed by that diff (pre-existing shared-dev-DB drift from
-- other branches: OwnerLedgerReconciliationFinding/Run, OwnerStatementFreezeManifestRow,
-- OwnerLedgerEntry.sourceAllocationEventId, OwnerStatementPeriod freeze columns, Party
-- default) deliberately excluded — none of that belongs to this migration.
ALTER TABLE "OwnerLedgerEntry" ADD COLUMN     "bankReference" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "memo" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "proofKey" TEXT,
ADD COLUMN     "proofStatus" TEXT,
ADD COLUMN     "requestFingerprint" TEXT,
ADD COLUMN     "reversalOfEntryId" UUID,
ADD COLUMN     "settlementKind" TEXT;

-- CreateTable
CREATE TABLE "OwnerRemittanceAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "payoutEntryId" UUID NOT NULL,
    "ownerStatementPeriodId" UUID NOT NULL,
    "allocatedAmountC" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerRemittanceAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerReceivableOffsetAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "offsetEntryId" UUID NOT NULL,
    "chargeId" UUID NOT NULL,
    "billingDocumentLineId" UUID,
    "allocatedAmountC" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerReceivableOffsetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerRemittanceAllocation_organizationId_ownerStatementPeri_idx" ON "OwnerRemittanceAllocation"("organizationId", "ownerStatementPeriodId");

-- CreateIndex
CREATE INDEX "OwnerRemittanceAllocation_organizationId_payoutEntryId_idx" ON "OwnerRemittanceAllocation"("organizationId", "payoutEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerRemittanceAllocation_organizationId_payoutEntryId_owne_key" ON "OwnerRemittanceAllocation"("organizationId", "payoutEntryId", "ownerStatementPeriodId");

-- CreateIndex
CREATE INDEX "OwnerReceivableOffsetAllocation_organizationId_chargeId_idx" ON "OwnerReceivableOffsetAllocation"("organizationId", "chargeId");

-- CreateIndex
CREATE INDEX "OwnerReceivableOffsetAllocation_organizationId_offsetEntryI_idx" ON "OwnerReceivableOffsetAllocation"("organizationId", "offsetEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerReceivableOffsetAllocation_organizationId_offsetEntryI_key" ON "OwnerReceivableOffsetAllocation"("organizationId", "offsetEntryId", "chargeId");

-- CreateIndex
CREATE INDEX "OwnerLedgerEntry_organizationId_ownerPartyId_settlementKind_idx" ON "OwnerLedgerEntry"("organizationId", "ownerPartyId", "settlementKind");

-- CreateIndex
CREATE INDEX "OwnerLedgerEntry_reversalOfEntryId_idx" ON "OwnerLedgerEntry"("reversalOfEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerLedgerEntry_organizationId_settlementKind_idempotencyK_key" ON "OwnerLedgerEntry"("organizationId", "settlementKind", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "OwnerRemittanceAllocation" ADD CONSTRAINT "OwnerRemittanceAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerRemittanceAllocation" ADD CONSTRAINT "OwnerRemittanceAllocation_payoutEntryId_fkey" FOREIGN KEY ("payoutEntryId") REFERENCES "OwnerLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerRemittanceAllocation" ADD CONSTRAINT "OwnerRemittanceAllocation_ownerStatementPeriodId_fkey" FOREIGN KEY ("ownerStatementPeriodId") REFERENCES "OwnerStatementPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReceivableOffsetAllocation" ADD CONSTRAINT "OwnerReceivableOffsetAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReceivableOffsetAllocation" ADD CONSTRAINT "OwnerReceivableOffsetAllocation_offsetEntryId_fkey" FOREIGN KEY ("offsetEntryId") REFERENCES "OwnerLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerReceivableOffsetAllocation" ADD CONSTRAINT "OwnerReceivableOffsetAllocation_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the postgres
-- superuser; RLS is defense-in-depth vs direct anon/authenticated access). Matches every
-- other Phase-2 table (see 20260711022155_add_bills_grid_models); required by
-- scripts/check-new-tables-have-rls.ts (CI lint on PRs into uat/prod).
ALTER TABLE "OwnerRemittanceAllocation"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnerReceivableOffsetAllocation" ENABLE ROW LEVEL SECURITY;
