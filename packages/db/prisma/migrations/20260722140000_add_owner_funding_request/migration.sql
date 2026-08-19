-- Accounting-document redesign P7, reshaped (2026-07-23): Owner Funding Request.
-- One NEW table: OwnerFundingRequest — a DELIBERATE admin-issued ask for the owner
-- to fund KAEN (e.g. a big repair far exceeds the rent collected this month). NOT
-- a BillingDocument/invoice/debit_note/receivable (KAEN is not earning this money);
-- NOT an auto-derived status (the already-carried-forward negative owner running
-- balance stays silent + automatic — no payout-math change). amount/reason are
-- admin-supplied. Purely additive + reversible: no existing table altered, zero
-- rows written.

-- CreateTable
CREATE TABLE "OwnerFundingRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "propertyId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedById" UUID NOT NULL,
    "settledAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerFundingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerFundingRequest_organizationId_ownerPartyId_status_idx" ON "OwnerFundingRequest"("organizationId", "ownerPartyId", "status");

-- AddForeignKey
ALTER TABLE "OwnerFundingRequest" ADD CONSTRAINT "OwnerFundingRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (hand-added on top of Prisma DDL; invisible to migrate diff, so no modeled drift).
-- Org-scoped + created after the 20260506 deny-all lockdown, so it MUST enable RLS
-- (deny-all default; the API 'postgres' role bypasses RLS). Mirrors
-- 20260722130000_add_kaen_operating_expense. Required by scripts/check-new-tables-have-rls.ts.
ALTER TABLE "OwnerFundingRequest" ENABLE ROW LEVEL SECURITY;
