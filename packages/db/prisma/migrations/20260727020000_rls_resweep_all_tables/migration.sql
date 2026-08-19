-- RLS re-sweep: enable Row Level Security on every public table (2026-07-27).
--
-- Fifth in the series (20260506000000 lockdown, 20260520000000, 20260629020000,
-- 20260705160000, 20260720140000). Requested explicitly for UAT: "enable all RLS for all
-- tables". Identical body to every prior sweep — a catalog loop, so it needs no table list
-- and cannot go stale.
--
-- State at authoring time, verified against the local DB (identical migration set to UAT
-- as of 20260727010000): 120/120 public tables already had relrowsecurity = true, and every
-- table created since the last sweep (OwnerRemittanceAllocation, OwnerReceivableOffsetAllocation,
-- SupplierExpense, SupplierExpenseAllocation, KaenOperatingExpense, OwnerFundingRequest) enables
-- RLS in its own migration, as the `check-new-tables-have-rls` CI lint requires. So this sweep is
-- EXPECTED TO BE A NO-OP. It is shipped anyway because the migration history is the only thing
-- that can be verified from outside the client DB — a sweep makes the end state guaranteed
-- rather than inferred, which is precisely why the four earlier ones exist.
--
-- What this does and does NOT do:
--   • DOES: `ENABLE ROW LEVEL SECURITY` on every table in `public`. With ZERO policies defined
--     (pg_policies is empty by design), that is a DENY-ALL for every non-owner role — i.e. the
--     Supabase `anon` and `authenticated` keys get nothing through PostgREST.
--   • Does NOT: `FORCE ROW LEVEL SECURITY`. The table owner (the API's connection role) keeps
--     bypassing RLS on purpose — the API enforces organizationId scoping itself, and forcing RLS
--     with no policies would deny the application its own data and take the service down.
--   • Does NOT add policies. Adding one would OPEN access, not restrict it.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op on a table that already has it. Additive:
-- touches no prior migration, breaks no checksum. Safe to re-run.
--
-- Rollback (NOT recommended — re-opens PostgREST access):
--   DO $$ DECLARE r record; BEGIN
--     FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' LOOP
--       EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
--     END LOOP; END $$;
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
