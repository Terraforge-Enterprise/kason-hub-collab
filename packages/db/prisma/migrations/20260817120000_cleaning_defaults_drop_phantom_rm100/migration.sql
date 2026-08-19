-- Drop the two phantom RM 100 cleaning defaults.
--
-- 1) UnitBillsBearerConfig.cleaningRecurringAmount: 100 -> 0.
--    `getOrCreateEntry` (bills-grid/repository.ts) seeds the month entry's `cleaning`
--    from this column, so the default was NOT cosmetic — every never-configured unit
--    froze a billable RM 100 onto its first period, competing with the grid's own
--    Recurring editor. 0 is the established disabled sentinel on this field
--    (backfill-recurring-defs.ts reads `0/null => disabled`).
--
-- 2) ManagementFeeConfig.cleaningAutoBill: drop the default entirely. The column is now
--    ORPHANED — the owner-settings field, its manual create/patch/void endpoints and the
--    statement issuer that consumed it were all removed. The column itself is retained on
--    purpose: a DROP COLUMN applied before the API ships would 500 old code still reading
--    it, and prod migrations here are manual and not ordered against the code deploy.
--    Drop the column in a follow-up once this change is live everywhere.
--
-- DEFAULT-ONLY, deliberately: no existing row is rewritten. A stored 100 that came from
-- the default is indistinguishable from a 100 an admin typed on purpose, so backfilling
-- would silently wipe real configured amounts. Existing apartments keep what they hold
-- until an admin edits them; only newly-created rows start clean.

ALTER TABLE "UnitBillsBearerConfig"
  ALTER COLUMN "cleaningRecurringAmount" SET DEFAULT 0;

ALTER TABLE "ManagementFeeConfig"
  ALTER COLUMN "cleaningAutoBill" DROP DEFAULT;
