-- RLS lockdown: deny-all baseline.
--
-- Every table in schema `public` gets ROW LEVEL SECURITY enabled with no
-- policies attached. The Hono API connects as the `postgres` superuser
-- (Prisma `DATABASE_URL`) and the Storage API uses the `service_role` key —
-- both bypass RLS. The `anon` and `authenticated` Supabase roles are
-- subject to RLS, so PostgREST queries with the publishable key get back
-- nothing.
--
-- We additionally revoke schema and object privileges from anon and
-- authenticated as belt-and-suspenders, and set DEFAULT PRIVILEGES so any
-- future table created in `public` auto-denies these roles even if a
-- future engineer forgets to enable RLS on it.
--
-- Idempotent: ALTER TABLE ENABLE ROW LEVEL SECURITY is a no-op when
-- already enabled, and REVOKE on already-revoked privileges is a no-op.

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

-- Guarded role revokes. Supabase environments have `anon` and `authenticated`
-- roles created by the platform; local Postgres typically does not. We only
-- run the revokes if the roles exist so the migration applies cleanly to
-- both. Production safety is unchanged because Supabase always has them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  ELSE
    RAISE NOTICE 'Skipping anon/authenticated revokes — roles not present (local dev).';
  END IF;
END;
$$;
