#!/usr/bin/env tsx
/**
 * Backfill: normalize phone columns to canonical "60XXXXXXXXX" form.
 *
 * Targets: User.phone, Party.primaryPhone, Party.whatsappPhone,
 * Party.emergencyContactPhone, CommissionClaimItem.tenantPhone.
 *
 * Excludes (intentionally): OrganizationCardSettings.agencyPhone (org branding,
 * different audience — may be a landline), AgentCardVersion.primaryPhone
 * (immutable snapshot). See the design spec for scope.
 *
 * Usage:
 *   DATABASE_URL=$LOCAL_DB_URL npx tsx scripts/normalize-phones.mts --dry-run
 *   DATABASE_URL=$LOCAL_DB_URL npx tsx scripts/normalize-phones.mts --commit
 *
 * Refuses to run without --dry-run or --commit (no implicit destructive mode).
 * Refuses to run without DATABASE_URL explicitly set.
 *
 * Output: redacted JSON summary to stdout. Full redacted diff to
 * phone-backfill.dryrun.log (gitignored). Unparseable rows to
 * phone-backfill.warnings.log (gitignored).
 *
 * Idempotent: re-running --dry-run after --commit yields updated: 0.
 *
 * SAFETY: NEVER runs against UAT until .claude/uat-migration-allowed is unlocked.
 * Operator must point DATABASE_URL at the intended environment explicitly.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";
import { normalizeMyPhone } from "@kason/shared";

export function redactForLog(phone: string): string {
  if (!phone) return "";
  if (phone.length < 4) return "*".repeat(phone.length);
  return "*".repeat(phone.length - 4) + phone.slice(-4);
}

export function planRowChange(
  stored: string | null | undefined,
): { from: string; to: string } | null {
  if (!stored) return null;
  const canonical = normalizeMyPhone(stored);
  if (!canonical) return null;
  if (canonical === stored) return null;
  return { from: stored, to: canonical };
}

type ColumnTarget = {
  table: string;
  idField: string;
  column: string;
};

const TARGETS: ColumnTarget[] = [
  { table: "User", idField: "id", column: "phone" },
  { table: "Party", idField: "id", column: "primaryPhone" },
  { table: "Party", idField: "id", column: "whatsappPhone" },
  { table: "Party", idField: "id", column: "emergencyContactPhone" },
  { table: "CommissionClaimItem", idField: "id", column: "tenantPhone" },
];

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

async function main() {
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

  const dbUrl = process.env.DATABASE_URL!;
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

  const dryLog = "phone-backfill.dryrun.log";
  const warnLog = "phone-backfill.warnings.log";
  if (DRY) fs.writeFileSync(dryLog, `# Dry run @ ${new Date().toISOString()}\n`);
  fs.writeFileSync(warnLog, `# Unparseable @ ${new Date().toISOString()}\n`);

  let inspected = 0;
  let updated = 0;
  let skipped = 0;
  let unparseable = 0;

  for (const target of TARGETS) {
    const rows: Array<{ id: string; v: string | null }> = await prisma.$queryRawUnsafe(
      `SELECT "${target.idField}" AS id, "${target.column}" AS v FROM "${target.table}" WHERE "${target.column}" IS NOT NULL`,
    );

    for (const row of rows) {
      inspected++;
      const change = planRowChange(row.v);
      if (!change) {
        if (row.v && !normalizeMyPhone(row.v)) {
          unparseable++;
          fs.appendFileSync(
            warnLog,
            `${target.table}.${target.column} id=${row.id} value=${redactForLog(row.v)}\n`,
          );
        } else {
          skipped++;
        }
        continue;
      }

      if (DRY) {
        fs.appendFileSync(
          dryLog,
          `${target.table}.${target.column} id=${row.id} ${redactForLog(change.from)} -> ${redactForLog(change.to)}\n`,
        );
      } else {
        await prisma.$executeRawUnsafe(
          `UPDATE "${target.table}" SET "${target.column}" = $1 WHERE "${target.idField}" = $2`,
          change.to,
          row.id,
        );
      }
      updated++;
    }
  }

  console.log(
    JSON.stringify({
      mode: DRY ? "dry-run" : "apply",
      inspected,
      updated,
      skipped,
      unparseable,
    }),
  );
  await prisma.$disconnect();
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1]?.endsWith("normalize-phones.mts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
