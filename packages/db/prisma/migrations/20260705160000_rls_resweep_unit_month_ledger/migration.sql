-- RLS re-sweep: enable Row Level Security on every public table.
--
-- Background: the 2026-06-29 re-sweep (20260629020000_rls_resweep_owner_billing)
-- enabled RLS on every public table at that time. Subsequent migrations created
-- new tables — UnitMonthLedger (20260703052039_unit_month_ledger) and
-- UnitUtilityBillAttachment (20260703114723_unit_utility_bill_attachment) —
-- without an individual `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, leaving
-- them open to PostgREST queries with the anon/authenticated keys and tripping
-- the CI lint `scripts/check-new-tables-have-rls.ts`.
--
-- Both migrations are already applied on the main dev/staging DB, so they must
-- NOT be edited (editing an applied migration causes a checksum mismatch on
-- deploy). This forward-only re-sweep is the safe fix: it runs AFTER every
-- prior migration and enables RLS on any table still missing it.
--
-- Idempotent — ENABLE ROW LEVEL SECURITY is a no-op on tables that already have
-- it. New tables get enabled; previously-covered tables get re-affirmed.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END;
$$;
