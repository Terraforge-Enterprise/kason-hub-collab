-- CreateTable
CREATE TABLE "OwnerExpenseProof" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "statementMonth" DATE NOT NULL,
    "apartmentId" UUID,
    "category" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerExpenseProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerExpenseProof_organizationId_ownerPartyId_statementMont_idx" ON "OwnerExpenseProof"("organizationId", "ownerPartyId", "statementMonth", "apartmentId", "category");

-- AddForeignKey
ALTER TABLE "OwnerExpenseProof" ADD CONSTRAINT "OwnerExpenseProof_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the postgres
-- superuser; RLS is defense-in-depth vs direct anon/authenticated access). Matches every
-- other Phase-2 table.
ALTER TABLE "OwnerExpenseProof" ENABLE ROW LEVEL SECURITY;

-- RenameIndex
-- Reconciles pre-existing index-name drift: migration 20260626120000_owner_ledger_utility_unique
-- hand-named this unique index "OwnerLedgerEntry_org_sourceType_sourceUtilityBillId_key", but the
-- schema's @@unique([organizationId, sourceType, sourceUtilityBillId]) (no explicit map:) expects
-- Prisma's auto-truncated name. Catalog-only rename — no data/columns touched. Bundled here because
-- this is the next generated migration; it makes `migrate diff` schema-vs-db empty.
ALTER INDEX "OwnerLedgerEntry_org_sourceType_sourceUtilityBillId_key" RENAME TO "OwnerLedgerEntry_organizationId_sourceType_sourceUtilityBil_key";
