-- RLS re-sweep: enable Row Level Security on every public table.
--
-- Background: 20260506000000_rls_lockdown_deny_all enabled RLS on every
-- table in `public` at that time. Subsequent migrations created new tables
-- (DocumentTemplate, ReferenceSequence, UnitReservation,
-- UnitReservationTransition, UnitListingModeTransition, Apartment,
-- UnitSubmission, PropertySubmission) but did not individually enable RLS,
-- leaving them open to PostgREST queries with the anon/authenticated keys.
--
-- This migration is a defensive re-sweep: identical body to the 2026-05-06
-- lockdown. Idempotent — ENABLE ROW LEVEL SECURITY is a no-op on tables
-- that already have it. New tables get enabled; old ones get re-affirmed.
--
-- Going forward, the CI check `scripts/check-new-tables-have-rls.ts`
-- catches this gap at PR time so we don't need another re-sweep.

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
