-- Owner-statement closed-period integrity (review self-heal): reversal corrections post
-- FORWARD, never mutate a frozen row. ADDITIVE + REVERSIBLE. LOCAL/UAT only — no prod ref.
--
-- The write-once `reversal` row is reconciled to targetC on EVERY sync-hook fire. When that
-- row has since FROZEN (its owner-statement month is a frozen period), the in-place
-- update/void mutates a manifest-snapshotted, PDF-issued row — breaching frozen immutability
-- and tripping R6 frozen-integrity. The fix posts the DELTA forward into the current OPEN
-- month as a new sourceType `reversal_forward_adjustment` (one per (charge, open-month)), so a
-- multi-freeze chain accumulates one adjustment row per month while every frozen row stays
-- byte-identical. That needs per-(charge, statementMonth) idempotency for the new sourceType,
-- which the broad (org, sourceType, sourceChargeId) partial unique (one-per-charge) cannot express.
--
-- New sourceType string 'reversal_forward_adjustment' is a plain value — NO enum/column change,
-- so NO Prisma client regeneration is required (OwnerLedgerEntry.sourceType is already `String`).

-- (1) Widen the broad partial-unique predicate to ALSO exclude 'reversal_forward_adjustment'
--     (legitimately multiple rows per charge — one per open month it corrects into). Safe and
--     reversible: the excluded type does NOT EXIST until this feature ships, so no existing row
--     can violate the recreated index. Mirrors migration 20260720000000's step-4 reasoning.
DROP INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key";
CREATE UNIQUE INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key"
    ON "OwnerLedgerEntry" ("organizationId", "sourceType", "sourceChargeId")
    WHERE "sourceType" NOT IN ('prior_period_collection', 'prior_period_collection_reversal', 'reversal_forward_adjustment');

-- (2) Per-(charge, statementMonth) partial unique for the new sourceType: a re-fire UPDATES
--     (never duplicates) the current open month's adjustment; a later open month gets its own
--     row. Race-safe insert path stays createMany({ skipDuplicates }) on this key.
CREATE UNIQUE INDEX "OwnerLedgerEntry_org_revFwdAdj_charge_month_key"
    ON "OwnerLedgerEntry" ("organizationId", "sourceChargeId", "statementMonth")
    WHERE "sourceType" = 'reversal_forward_adjustment';

-- ROLLBACK (manual; safe while the feature is flag-dark — no reversal_forward_adjustment rows exist):
--   DROP INDEX "OwnerLedgerEntry_org_revFwdAdj_charge_month_key";
--   DROP INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key";
--   CREATE UNIQUE INDEX "OwnerLedgerEntry_org_sourceType_sourceChargeId_active_key"
--     ON "OwnerLedgerEntry" ("organizationId", "sourceType", "sourceChargeId")
--     WHERE "sourceType" NOT IN ('prior_period_collection', 'prior_period_collection_reversal');
--   -- If any reversal_forward_adjustment rows already exist across >1 month for a charge, DELETE
--   -- them BEFORE recreating the broad index (its widened predicate would otherwise treat two
--   -- months' adjustments for one charge as one-per-charge duplicates). None exist while flag-dark.
