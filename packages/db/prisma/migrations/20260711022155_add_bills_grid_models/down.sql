-- Forward-only rollback (no `git revert`; apply these as a NEW migration).
-- Children first: all three cascade from UnitBillsGridEntry.
DROP TABLE IF EXISTS "GridMeterReading";
DROP TABLE IF EXISTS "GridExpense";
DROP TABLE IF EXISTS "GridAttachment";
DROP TABLE IF EXISTS "UnitBillsBearerConfig";
DROP TABLE IF EXISTS "UnitBillsGridEntry";
-- Dropping the tables drops their RLS with them; no extra statements needed.
-- DROP TABLE also drops that table's indexes, so the GridMeterReading unique
-- index over (organizationId, entryId, listingId) needs no explicit DROP INDEX.
-- No other table references these, so the drop is complete and leaves the
-- owner-ledger / owner-statement / /billing/charges surfaces byte-identical.
