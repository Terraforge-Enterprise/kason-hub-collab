-- RLS re-sweep: enable Row Level Security on every public table.
--
-- Background: 20260506000000_rls_lockdown_deny_all enabled RLS on every table
-- in `public`, and 20260520000000_rls_resweep_for_new_tables re-affirmed it.
-- Since then, five tables were created WITHOUT an in-migration
-- `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, leaving them open to PostgREST
-- queries with the anon/authenticated keys:
--   PaymentAllocationReversal (20260714000000)
--   OwnerStatementPeriod      (20260719000000)
--   RecurringChargeDefinition, RecurringChargeRevision, GridEntryRecurringLine
--                             (20260720120000)
-- The gap went uncaught because `scripts/check-new-tables-have-rls.ts` only
-- runs in CI on PRs into uat/prod, and these landed on `master` (which has no
-- CI) before the first promotion that re-ran the lint.
--
-- This migration is a defensive re-sweep: identical body to the 2026-05-06
-- lockdown / 2026-05-20 re-sweep. Idempotent — ENABLE ROW LEVEL SECURITY is a
-- no-op on tables that already have it. New tables get enabled; old ones get
-- re-affirmed. Additive: touches no existing migration, breaks no checksum.
--
-- Spec: docs/superpowers/specs/2026-05-06-supabase-rls-lockdown-design.md

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
