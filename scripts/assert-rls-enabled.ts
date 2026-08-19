/**
 * Deploy gate: assert every table in `public` has Row Level Security ENABLED.
 *
 * Why this exists alongside the other two RLS checks — they cover different gaps:
 *   • `check-new-tables-have-rls.ts` (CI lint) reads MIGRATION TEXT. It catches a new
 *     `CREATE TABLE` that forgot its `ENABLE ROW LEVEL SECURITY`, but only for PRs into
 *     uat/prod — and it can only ever prove what the migrations SAY.
 *   • `check-rls.ts` reads the LIVE DB but is a REPORTER: it prints and always exits 0.
 *   • This script reads the LIVE DB and FAILS (exit 1) when any public table has RLS off.
 *
 * That distinction matters because the client databases are not reachable from a dev machine,
 * so their RLS posture was previously INFERRED from migration history rather than observed.
 * Wired into cd-uat-deploy.yml immediately after `prisma migrate deploy`.
 *
 * With ZERO policies defined (the deliberate design — see
 * docs/superpowers/specs/2026-05-06-supabase-rls-lockdown-design.md), RLS enabled means
 * DENY-ALL for every non-owner role: the Supabase `anon` and `authenticated` keys get nothing
 * through PostgREST. A table with RLS off and no policy is therefore fully exposed to those
 * keys — which is exactly what this gate refuses to let ship.
 *
 * Deliberately does NOT assert `FORCE ROW LEVEL SECURITY`. The table owner (the API's
 * connection role) bypasses RLS on purpose: the API enforces organizationId scoping itself,
 * and forcing RLS with no policies would deny the application its own data and take the
 * service down. `force` is reported, never required.
 *
 * Read-only — catalog queries only.
 *
 * Run locally:  DATABASE_URL=... npx tsx scripts/assert-rls-enabled.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

interface TableRls {
  tablename: string;
  rowsecurity: boolean;
  forcerowsecurity: boolean;
}

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set — refusing to report a PASS against nothing.");
    process.exit(1);
  }
  // Same connection handling as scripts/check-rls.ts: Supabase rejects the sslmode param
  // supplied this way, and its cert chain needs rejectUnauthorized:false.
  const url = raw.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  // …but SSL must be OFF for a local Postgres, which answers "the server does not support SSL
  // connections" and fails the gate for the wrong reason. check-rls.ts hardcodes SSL because it
  // is only ever pointed at Supabase; this one is a deploy gate that must also be runnable
  // locally before shipping, so the host decides.
  const host = new URL(url).hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    }),
  });

  try {
    const tables: TableRls[] = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS rowsecurity,
              c.relforcerowsecurity AS forcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`
    );
    const policies: { n: bigint }[] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::bigint AS n FROM pg_policies WHERE schemaname = 'public'`
    );

    // An empty public schema means we are pointed somewhere unexpected — a vacuous
    // "0/0 enabled" PASS would be worse than useless on a deploy gate.
    if (tables.length === 0) {
      console.error("No tables found in schema `public` — wrong database? Refusing to pass.");
      process.exit(1);
    }

    const off = tables.filter((t) => !t.rowsecurity);
    const policyCount = Number(policies[0]?.n ?? 0);
    console.log(
      `RLS enabled on ${tables.length - off.length}/${tables.length} public tables; ` +
        `${policyCount} policies defined${policyCount === 0 ? " (0 = deny-all by design)" : ""}.`
    );

    if (off.length > 0) {
      console.error(
        `::error::RLS is DISABLED on ${off.length} table(s), leaving them readable with the ` +
          `Supabase anon/authenticated keys: ${off.map((t) => t.tablename).join(", ")}`
      );
      process.exit(1);
    }
    console.log("PASS — every public table has RLS enabled.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
