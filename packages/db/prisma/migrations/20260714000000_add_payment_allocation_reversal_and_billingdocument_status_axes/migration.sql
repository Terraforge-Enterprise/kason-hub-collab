-- CreateTable
CREATE TABLE "PaymentAllocationReversal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "originalAllocationId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "reversedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    CONSTRAINT "PaymentAllocationReversal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentAllocationReversal_organizationId_idempotencyKey_key" ON "PaymentAllocationReversal"("organizationId", "idempotencyKey");
CREATE INDEX "PaymentAllocationReversal_originalAllocationId_idx" ON "PaymentAllocationReversal"("originalAllocationId");
CREATE INDEX "PaymentAllocationReversal_organizationId_createdAt_idx" ON "PaymentAllocationReversal"("organizationId", "createdAt");

-- AlterTable
ALTER TABLE "BillingDocument" ADD COLUMN "documentStatus" TEXT NOT NULL DEFAULT 'ISSUED';
ALTER TABLE "BillingDocument" ADD COLUMN "settlementStatus" TEXT NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "BillingDocument" ADD COLUMN "taxStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE "BillingDocument" ADD COLUMN "supersededByDocumentId" UUID;
CREATE INDEX "BillingDocument_organizationId_documentStatus_idx" ON "BillingDocument"("organizationId", "documentStatus");
CREATE INDEX "BillingDocument_organizationId_settlementStatus_idx" ON "BillingDocument"("organizationId", "settlementStatus");

-- Backfill from legacy status (spec Data Model). documentStatus defaults ISSUED (issued/partially_settled/settled), offset→CANCELLED.
UPDATE "BillingDocument" SET "documentStatus" = 'CANCELLED' WHERE "status" = 'offset';
-- settlementStatus defaults UNPAID (issued); map the rest.
UPDATE "BillingDocument" SET "settlementStatus" = 'PARTIALLY_PAID' WHERE "status" = 'partially_settled';
UPDATE "BillingDocument" SET "settlementStatus" = 'PAID' WHERE "status" IN ('settled', 'offset');
