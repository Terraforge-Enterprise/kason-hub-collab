import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const url = process.env.DATABASE_URL!
    .replace(/([?&])sslmode=[^&]*&?/g, "$1")
    .replace(/[?&]$/, "");
  const adapter = new PrismaPg({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  const dbInfo: { current_database: string; inet_server_addr: string | null }[] =
    await prisma.$queryRawUnsafe(
      `SELECT current_database(), inet_server_addr()::text`
    );
  console.log("=== Connected to ===");
  console.log(JSON.stringify(dbInfo[0]));
  console.log("");

  const rows: {
    schemaname: string;
    tablename: string;
    rowsecurity: boolean;
    forcerowsecurity: boolean;
  }[] = await prisma.$queryRawUnsafe(
    `SELECT n.nspname AS schemaname,
            c.relname AS tablename,
            c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS forcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`
  );

  const policies: {
    tablename: string;
    policyname: string;
    cmd: string;
    roles: string[];
  }[] = await prisma.$queryRawUnsafe(
    `SELECT tablename, policyname, cmd, roles::text[] AS roles
     FROM pg_policies
     WHERE schemaname = 'public'
     ORDER BY tablename, policyname`
  );

  const rlsOn = rows.filter((r) => r.rowsecurity);
  const rlsOff = rows.filter((r) => !r.rowsecurity);

  console.log(`Total tables in public: ${rows.length}`);
  console.log(`RLS ENABLED:  ${rlsOn.length}`);
  console.log(`RLS DISABLED: ${rlsOff.length}`);
  console.log(`Policies defined: ${policies.length}`);

  console.log("\n=== RLS DISABLED tables ===");
  if (rlsOff.length === 0) console.log("  (none — all tables have RLS on)");
  rlsOff.forEach((r) => console.log(`  ${r.tablename}`));

  console.log("\n=== RLS ENABLED tables ===");
  if (rlsOn.length === 0) console.log("  (none)");
  rlsOn.forEach((r) =>
    console.log(`  ${r.tablename}  (force=${r.forcerowsecurity})`)
  );

  console.log("\n=== Policies ===");
  if (policies.length === 0) console.log("  (none)");
  policies.forEach((p) =>
    console.log(
      `  ${p.tablename}.${p.policyname}  cmd=${p.cmd}  roles=${p.roles.join(",")}`
    )
  );

  const grants: {
    table_name: string;
    grantee: string;
    privilege_type: string;
  }[] = await prisma.$queryRawUnsafe(
    `SELECT table_name, grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
     ORDER BY table_name, grantee, privilege_type`
  );
  console.log(
    `\n=== Direct grants to anon/authenticated/PUBLIC: ${grants.length} ===`
  );
  const byTableGrantee = new Map<string, Set<string>>();
  grants.forEach((g) => {
    const key = `${g.table_name}::${g.grantee}`;
    if (!byTableGrantee.has(key)) byTableGrantee.set(key, new Set());
    byTableGrantee.get(key)!.add(g.privilege_type);
  });
  for (const [key, privs] of byTableGrantee) {
    const [table, grantee] = key.split("::");
    console.log(`  ${table}  ${grantee}  [${[...privs].join(",")}]`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
