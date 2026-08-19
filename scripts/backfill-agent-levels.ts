#!/usr/bin/env tsx
/**
 * One-shot backfill that brings every org's agent levels up to the
 * correct tier based on historical paid commissions. Safe to re-run —
 * sweepOrgAgentLevels is one-way and idempotent.
 *
 * Usage:
 *   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx scripts/backfill-agent-levels.ts --dry-run
 *   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx scripts/backfill-agent-levels.ts --commit
 *
 * Refuses to run without --dry-run or --commit.
 * Refuses to run without DATABASE_URL explicitly set.
 *
 * This is a script, NOT an HTTP endpoint — cross-org mutations must
 * remain a human-operator action, not a web surface.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";
import { sweepOrgAgentLevels } from "../apps/api/src/modules/commissions/agent-level-upgrade";

const DRY = process.argv.includes("--dry-run");
const COMMIT = process.argv.includes("--commit");

if (!DRY && !COMMIT) {
  console.error("Missing mode flag. Pass --dry-run or --commit.");
  process.exit(2);
}
if (DRY && COMMIT) {
  console.error("Pass only one of --dry-run or --commit.");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be explicitly set in the environment.");
  process.exit(2);
}

// Mirror packages/db/src/client.ts — PrismaPg adapter is required by this
// project's schema (no datasource url field; driver adapter mode).
function resolveSsl(): { ca: Buffer; rejectUnauthorized: true } | { rejectUnauthorized: false } {
  const caPath =
    process.env.SUPABASE_CA_CERT_PATH ?? path.join(process.cwd(), "certs/supabase-ca.crt");
  try {
    const ca = fs.readFileSync(caPath);
    return { ca, rejectUnauthorized: true as const };
  } catch {
    return { rejectUnauthorized: false as const };
  }
}

function stripSslmode(url: string): string {
  return url.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
}

function wantsSsl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    const sslmode = parsed.searchParams.get("sslmode");
    if (sslmode === "disable") return false;
    return true;
  } catch {
    return true;
  }
}

const dbUrl = process.env.DATABASE_URL!; // guarded above
const adapter = new PrismaPg(
  {
    connectionString: stripSslmode(dbUrl),
    ssl: wantsSsl(dbUrl) ? resolveSsl() : false,
    idleTimeoutMillis: 30_000,
    max: 5,
    connectionTimeoutMillis: 10_000,
  },
  { disposeExternalPool: false },
);

const prisma = new PrismaClient({ adapter });

const DRY_ROLLBACK_SENTINEL = "__DRY_RUN_ROLLBACK__";

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
  console.log(`Found ${orgs.length} organization(s).`);

  let totalBumps = 0;

  for (const org of orgs) {
    console.log(`\n[${org.name} / ${org.id}]`);

    if (DRY) {
      // Preview — run the sweep inside a tx, then throw to force rollback.
      try {
        await prisma.$transaction(async (tx) => {
          const bumps = await sweepOrgAgentLevels(tx, org.id);
          console.log(`  would bump ${bumps.length} agent(s).`);
          for (const b of bumps) {
            console.log(`    ${b.agentId}: ${b.from} → ${b.to} (cumulative RM ${b.cumulative})`);
          }
          totalBumps += bumps.length;
          throw new Error(DRY_ROLLBACK_SENTINEL);
        });
      } catch (err) {
        if ((err as Error).message !== DRY_ROLLBACK_SENTINEL) throw err;
      }
    } else {
      const bumps = await prisma.$transaction((tx) => sweepOrgAgentLevels(tx, org.id));
      console.log(`  bumped ${bumps.length} agent(s).`);
      for (const b of bumps) {
        console.log(`    ${b.agentId}: ${b.from} → ${b.to} (cumulative RM ${b.cumulative})`);
      }
      totalBumps += bumps.length;
    }
  }

  console.log(`\nTotal ${DRY ? "would-bump" : "bumped"}: ${totalBumps}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
