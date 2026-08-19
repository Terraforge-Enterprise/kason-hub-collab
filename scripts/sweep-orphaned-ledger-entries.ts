// scripts/sweep-orphaned-ledger-entries.ts
//
// ONE-TIME RECONCILIATION — void orphaned sync-owned OwnerLedgerEntry rows.
//
// Before P3, NO void path re-synced the owner ledger: voiding a posted charge /
// utility bill / owner statement left its synced ledger row silently `active`,
// misstating the owner's payout. Task 9 fixed the go-forward path (reverse pass
// in syncMonthService); THIS script reconciles rows already orphaned in real
// books. Status flips only (reversible); admin-edited rows are NEVER touched.
//
// Orphan definition (identical to the Task-9 reverse pass in
// apps/api/src/modules/owner-ledger/owner-ledger.sync.ts):
//   OwnerLedgerEntry WHERE status='active' AND updatedById = SYNC_ACTOR_ID AND (
//        sourceChargeId      → Charge.status IN ('void','credited')
//     OR sourceInvoiceId     → Invoice.status = 'void'
//     OR sourceUtilityBillId → UnitUtilityBill.status = 'void'
//   )
//
// The --apply path is DOUBLE-GUARDED (same pattern as
// cleanup-per-unit-owner-statements.ts):
//   1. CLI flag:  --apply
//   2. Env var:   CLEANUP_CONFIRM=yes
// Both must be present; otherwise the script exits after the dry-run table.
//
// EXECUTION IS USER-GATED PER ENVIRONMENT: do not run (even dry-run against a
// non-local DATABASE_URL) without explicit user go-ahead for that environment.
//
// Idempotent: the query only ever selects status='active' rows, so once a row
// is flipped to 'void' it drops out of the candidate set on the next run.
//
// Usage:
//   # Dry-run (mutates nothing):
//   DATABASE_URL=<url> node_modules/.bin/tsx scripts/sweep-orphaned-ledger-entries.ts
//
//   # Apply:
//   DATABASE_URL=<url> CLEANUP_CONFIRM=yes node_modules/.bin/tsx scripts/sweep-orphaned-ledger-entries.ts --apply

import "dotenv/config";
import { db } from "@kason/db";
import type { Prisma } from "@kason/db";
import { SYNC_ACTOR_ID } from "../apps/api/src/modules/owner-ledger/owner-ledger.sync";
import { resolveSystemActor } from "../apps/api/src/modules/billing/auto-draft.repository";
import { recordAudit } from "../apps/api/src/lib/audit";

export type OrphanRow = {
  id: string;
  organizationId: string;
  ownerPartyId: string;
  statementMonth: Date;
  direction: string;
  category: string;
  amount: unknown;
  sourceType: string;
  sourceChargeId: string | null;
  sourceInvoiceId: string | null;
  sourceUtilityBillId: string | null;
};

export type DeadSourceSets = {
  charge: Set<string>;
  invoice: Set<string>;
  bill: Set<string>;
};

/**
 * Mirrors the Task-9 reverse-pass dead-source predicate in
 * owner-ledger.sync.ts EXACTLY: a row is orphaned if ANY ONE of its (at most
 * one non-null) source links points at a dead source.
 */
export function isOrphan(
  row: Pick<OrphanRow, "sourceChargeId" | "sourceInvoiceId" | "sourceUtilityBillId">,
  dead: DeadSourceSets,
): boolean {
  return (
    (row.sourceChargeId !== null && dead.charge.has(row.sourceChargeId)) ||
    (row.sourceInvoiceId !== null && dead.invoice.has(row.sourceInvoiceId)) ||
    (row.sourceUtilityBillId !== null && dead.bill.has(row.sourceUtilityBillId))
  );
}

/**
 * The double-guard idiom (same as cleanup-per-unit-owner-statements.ts):
 * both the `--apply` CLI flag AND CLEANUP_CONFIRM=yes must be present.
 * Anything else (neither, either alone, or CLEANUP_CONFIRM set to a value
 * other than the literal "yes") stays in dry-run mode.
 */
export function guardsSatisfied(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--apply") && env.CLEANUP_CONFIRM === "yes";
}

export async function findOrphans(): Promise<OrphanRow[]> {
  const candidates = await db.ownerLedgerEntry.findMany({
    where: { status: "active", updatedById: SYNC_ACTOR_ID },
    select: {
      id: true,
      organizationId: true,
      ownerPartyId: true,
      statementMonth: true,
      direction: true,
      category: true,
      amount: true,
      sourceType: true,
      sourceChargeId: true,
      sourceInvoiceId: true,
      sourceUtilityBillId: true,
    },
  });
  const chargeIds = [...new Set(candidates.map((r) => r.sourceChargeId).filter((v): v is string => v !== null))];
  const invoiceIds = [...new Set(candidates.map((r) => r.sourceInvoiceId).filter((v): v is string => v !== null))];
  const billIds = [...new Set(candidates.map((r) => r.sourceUtilityBillId).filter((v): v is string => v !== null))];
  const [deadCharges, deadInvoices, deadBills] = await Promise.all([
    chargeIds.length
      ? db.charge.findMany({ where: { id: { in: chargeIds }, status: { in: ["void", "credited"] } }, select: { id: true } })
      : Promise.resolve([]),
    invoiceIds.length
      ? db.invoice.findMany({ where: { id: { in: invoiceIds }, status: "void" }, select: { id: true } })
      : Promise.resolve([]),
    billIds.length
      ? db.unitUtilityBill.findMany({ where: { id: { in: billIds }, status: "void" }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const dead: DeadSourceSets = {
    charge: new Set(deadCharges.map((c) => c.id)),
    invoice: new Set(deadInvoices.map((i) => i.id)),
    bill: new Set(deadBills.map((b) => b.id)),
  };
  return candidates.filter((r) => isOrphan(r, dead));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const confirmed = process.env.CLEANUP_CONFIRM === "yes";

  const orphans = await findOrphans();

  console.log(`\nOrphaned sync-owned ledger rows (active, source void/credited): ${orphans.length}\n`);
  for (const r of orphans) {
    console.log(
      [
        r.id,
        `org=${r.organizationId.slice(0, 8)}`,
        `owner=${r.ownerPartyId.slice(0, 8)}`,
        `month=${r.statementMonth.toISOString().slice(0, 7)}`,
        `${r.direction}/${r.category}`,
        `RM${String(r.amount)}`,
        `src=${r.sourceType}`,
      ].join("  "),
    );
  }

  if (!guardsSatisfied(process.argv, process.env)) {
    console.log(
      `\nDRY-RUN ONLY. To apply: CLEANUP_CONFIRM=yes ... --apply (both required; ` +
        `apply=${apply}, CLEANUP_CONFIRM=${confirmed ? "yes" : "unset"})`,
    );
    return;
  }

  let flipped = 0;
  for (const r of orphans) {
    const actor = await resolveSystemActor(r.organizationId);
    if (!actor) {
      console.warn(`SKIP ${r.id}: org ${r.organizationId} has no admin user for audit attribution`);
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.ownerLedgerEntry.update({
        where: { id: r.id },
        data: { status: "void", updatedById: SYNC_ACTOR_ID },
      });
      await recordAudit(tx, {
        organizationId: r.organizationId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_ledger.entry.reverse_synced",
        entityType: "OwnerLedgerEntry",
        entityId: r.id,
        meta: {
          sweep: true,
          month: r.statementMonth.toISOString().slice(0, 7),
          sourceChargeId: r.sourceChargeId,
          sourceInvoiceId: r.sourceInvoiceId,
          sourceUtilityBillId: r.sourceUtilityBillId,
        } as unknown as Prisma.InputJsonValue,
      });
    });
    flipped += 1;
  }
  console.log(`\nApplied: ${flipped}/${orphans.length} rows flipped to void (audited).`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
