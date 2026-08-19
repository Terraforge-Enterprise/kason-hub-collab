-- Owner-statement closed-period integrity — ADDITIVE, REVERSIBLE schema (Commit 2: Task 3 + Task 5).
-- Supports R3 (forward-collection idempotency), R7 (write-once freeze manifest) and R8 (durable
-- reconciliation persistence). LOCAL/UAT only — no prod ref. New sourceType string values
-- ('prior_period_adjustment','prior_period_collection','prior_period_collection_reversal') are plain
-- strings — NO enum/schema change.
--
-- Order (per spec Data Model): (1) new tables; (2) OwnerStatementPeriod write-once cols;
-- (3) OwnerLedgerEntry.sourceAllocationEventId + its unique; (4) narrow the sourceChargeId unique to a
-- PARTIAL unique index. Step 4 is safe/reversible because the excluded sourceTypes DO NOT EXIST until
-- this feature ships — no existing row can violate the recreated full unique on rollback.

-- (1) ─────────────────────────────────────────────────────────────────────────
-- R7: write-once freeze manifest (one row per ACTIVE OwnerLedgerEntry captured at FIRST freeze).
CREATE TABLE "OwnerStatementFreezeManifestRow" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerStatementPeriodId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "apartmentId" UUID,
    "periodMonth" DATE NOT NULL,
    "ledgerEntryId" UUID NOT NULL,
    "amountC" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "paidBy" TEXT NOT NULL,
    "includeInPayout" BOOLEAN NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "sstAmountC" INTEGER,
    "statementMonth" DATE NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceChargeId" UUID,
    "ledgerUpdatedAtAtFreeze" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerStatementFreezeManifestRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerStmtFreezeManifest_org_period_idx" ON "OwnerStatementFreezeManifestRow"("organizationId", "ownerStatementPeriodId");

-- R5/R6/R8: durable reconciliation finding (survives AuditLog's 10-day purge).
CREATE TABLE "OwnerLedgerReconciliationFinding" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerPartyId" UUID NOT NULL,
    "apartmentId" UUID,
    "unitId" UUID,
    "carparkId" UUID,
    "checkKind" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "originalBillingMonth" DATE,
    "expectedPostingMonth" DATE,
    "expectedDirection" TEXT,
    "expectedAmountC" INTEGER,
    "actualAmountC" INTEGER,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "detailsJson" JSONB,

    CONSTRAINT "OwnerLedgerReconciliationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerLedgerReconFinding_dedupe_key" ON "OwnerLedgerReconciliationFinding"("organizationId", "checkKind", "sourceType", "sourceId", "findingType");
CREATE INDEX "OwnerLedgerReconFinding_org_status_sev_idx" ON "OwnerLedgerReconciliationFinding"("organizationId", "status", "severity");
CREATE INDEX "OwnerLedgerReconFinding_org_owner_check_idx" ON "OwnerLedgerReconciliationFinding"("organizationId", "ownerPartyId", "checkKind");

-- R8/R9: durable reconciliation run record (feeds the enablement preflight).
CREATE TABLE "OwnerLedgerReconciliationRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reconciliationType" TEXT NOT NULL,
    "scopeJson" JSONB,
    "isFullScope" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "sourcesScanned" INTEGER NOT NULL DEFAULT 0,
    "findingsOpened" INTEGER NOT NULL DEFAULT 0,
    "findingsResolved" INTEGER NOT NULL DEFAULT 0,
    "triggerType" TEXT NOT NULL,
    "triggeredById" UUID,
    "failureInfo" TEXT,

    CONSTRAINT "OwnerLedgerReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerLedgerReconRun_org_type_status_idx" ON "OwnerLedgerReconciliationRun"("organizationId", "reconciliationType", "status");
CREATE INDEX "OwnerLedgerReconRun_org_startedAt_idx" ON "OwnerLedgerReconciliationRun"("organizationId", "startedAt");

-- (2) ─────────────────────────────────────────────────────────────────────────
-- R7: OwnerStatementPeriod write-once freeze header (nullable; set only on first freeze).
ALTER TABLE "OwnerStatementPeriod"
    ADD COLUMN "firstFrozenAt" TIMESTAMP(3),
    ADD COLUMN "firstFrozenOpeningC" INTEGER,
    ADD COLUMN "firstFrozenClosingC" INTEGER,
    ADD COLUMN "firstFrozenNetC" INTEGER,
    ADD COLUMN "freezeRulesetVersion" INTEGER;

-- (3) ─────────────────────────────────────────────────────────────────────────
-- R3: forward-collection idempotency key. Nullable ⇒ Postgres NULLs-distinct leaves all existing rows
-- unconstrained. Non-null only on prior_period_collection / prior_period_collection_reversal rows.
ALTER TABLE "OwnerLedgerEntry" ADD COLUMN "sourceAllocationEventId" UUID;

-- CreateIndex (new idempotency unique — matches @@unique map: in schema.prisma)
CREATE UNIQUE INDEX "OwnerLedgerEntry_org_sourceType_allocEvent_key" ON "OwnerLedgerEntry"("organizationId", "sourceType", "sourceAllocationEventId");

-- (4) ─────────────────────────────────────────────────────────────────────────
-- Narrow the existing (organizationId, sourceType, sourceChargeId) unique to a PARTIAL unique index
-- that EXCLUDES the two forward-collection sourceTypes (legitimately multiple rows per charge — one per
-- allocation event). prior_period_adjustment stays covered (exactly one PPA per charge), and the normal
-- manual/rent/statement/utility types keep their per-charge dedup. Prisma 7 cannot express a partial
-- @@unique, so this index lives ONLY here (mirrors Charge_*_active_key duplicate-prevention pattern).
DROP INDEX "OwnerLedgerEntry_organizationId_sourceType_sourceChargeId_key";
CREATE UNIQUE INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key"
    ON "OwnerLedgerEntry" ("organizationId", "sourceType", "sourceChargeId")
    WHERE "sourceType" NOT IN ('prior_period_collection', 'prior_period_collection_reversal');

-- AddForeignKey
ALTER TABLE "OwnerStatementFreezeManifestRow" ADD CONSTRAINT "OwnerStatementFreezeManifestRow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerStatementFreezeManifestRow" ADD CONSTRAINT "OwnerStatementFreezeManifestRow_ownerStatementPeriodId_fkey" FOREIGN KEY ("ownerStatementPeriodId") REFERENCES "OwnerStatementPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerLedgerReconciliationFinding" ADD CONSTRAINT "OwnerLedgerReconciliationFinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OwnerLedgerReconciliationRun" ADD CONSTRAINT "OwnerLedgerReconciliationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ROLLBACK (manual, if ever needed — this migration is additive + reversible):
--   DROP TABLE "OwnerStatementFreezeManifestRow", "OwnerLedgerReconciliationFinding", "OwnerLedgerReconciliationRun";
--   ALTER TABLE "OwnerStatementPeriod" DROP COLUMN "firstFrozenAt", DROP COLUMN "firstFrozenOpeningC",
--     DROP COLUMN "firstFrozenClosingC", DROP COLUMN "firstFrozenNetC", DROP COLUMN "freezeRulesetVersion";
--   DROP INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key";
--   DROP INDEX "OwnerLedgerEntry_org_sourceType_allocEvent_key";
--   ALTER TABLE "OwnerLedgerEntry" DROP COLUMN "sourceAllocationEventId";
--   CREATE UNIQUE INDEX "OwnerLedgerEntry_organizationId_sourceType_sourceChargeId_key"
--     ON "OwnerLedgerEntry"("organizationId", "sourceType", "sourceChargeId");  -- safe: excluded types don't exist
