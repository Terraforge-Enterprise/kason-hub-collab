// scripts/heal-desynced-ledger-voids.ts
//
// ONE-TIME REMEDIATION (Spec R6) — heal pre-existing shallow-void desyncs.
//
// Before this plan's Tasks 2-3 (409 VOID_AT_SOURCE guard + voidEntry stamping
// the acting admin), a shallow void of an OwnerLedgerEntry row derived from a
// Charge/Invoice/UnitUtilityBill could set status:"void" WITHOUT checking the
// source's liveness and WITHOUT changing updatedById away from SYNC_ACTOR_ID —
// a permanent desync (the ledger says void; the real charge/invoice/bill is
// still live/money-owed). THIS script finds exactly those bug-victim rows and
// heals them back to status:"active", writing ONLY the status column (never
// updatedById — a healed row must stay SYNC_ACTOR_ID-owned so a future
// genuine reversal can still void it).
//
// NOT to be confused with scripts/sweep-orphaned-ledger-entries.ts, which
// fixes the OPPOSITE desync (active rows whose source already died, from the
// pre-reverse-pass era) — a different tool for a different historical bug.
//
// Heal predicate — mirrors owner-ledger.sync.ts's reverse pass (~745-816)
// EXACTLY, inverted (heal iff NO source ref the row carries is dead):
//   status = "void" AND updatedById = SYNC_ACTOR_ID
//   AND (sourceChargeId      IS NULL OR Charge.status      NOT IN ('void','credited'))
//   AND (sourceInvoiceId     IS NULL OR Invoice.status     <> 'void')
//   AND (sourceUtilityBillId IS NULL OR UnitUtilityBill.status <> 'void')
//   -> status = "active"
//
// A row dead by ANY ONE source ref is left "void" forever — critically, a
// whole-statement Invoice void leaves its child Charges live, so a statement
// row (sourceChargeId + sourceInvoiceId both set) whose Invoice is void must
// NOT be healed even though its child Charge is live.
// `updatedById = SYNC_ACTOR_ID` excludes real admin voids (voidEntry stamps
// the acting admin's own id — Task 3), so this script only ever touches
// bug-victim rows the sync itself created and (falsely) voided.
//
// MONEY-SAFETY (review hardening):
//  • DRY-RUN by DEFAULT. Writing needs BOTH `--apply` AND HEAL_CONFIRM=yes
//    (mirrors sweep-orphaned-ledger-entries.ts). A bare invocation never writes.
//  • DELIBERATE-VOID EXCLUSION (default-safe): the pre-R3 shallow void was a
//    DELIBERATE admin action, so a healable row can be a duplicate an admin
//    voided on purpose. Each candidate is CROSS-REFERENCED against
//    AuditLog(action="owner_ledger.entry.void"); any candidate carrying such
//    an audit is EXCLUDED from the write BY DEFAULT (blind-healing one would
//    re-inflate the owner's payout — the original over-heal). The exclusion
//    list is printed BEFORE any write, dry-run or not. Pass `--include-
//    deliberate` to heal those rows too, once reviewed. The heal PREDICATE
//    itself (below) is unaffected either way.
//  • AUDIT TRAIL: every heal writes a per-row AuditLog
//    (action="owner_ledger.entry.heal_desync", before/after status + source
//    refs) attributed to a REAL org admin, inside the same guarded write tx.
//
// Idempotent: only status="void" rows are ever selected, so a healed row (now
// "active") drops out of the candidate set on the next run.
//
// Usage (DRY-RUN by DEFAULT):
//   # Dry-run report (mutates nothing) — also FLAGS deliberate-void candidates:
//   DATABASE_URL=<url> node_modules/.bin/tsx scripts/heal-desynced-ledger-voids.ts
//
//   # Apply (BOTH gates required; each heal is audited as heal_desync).
//   # Flagged deliberate-void candidates are EXCLUDED by default:
//   DATABASE_URL=<url> HEAL_CONFIRM=yes node_modules/.bin/tsx scripts/heal-desynced-ledger-voids.ts --apply
//
//   # To ALSO heal flagged deliberate-void candidates, opt in explicitly:
//   DATABASE_URL=<url> HEAL_CONFIRM=yes node_modules/.bin/tsx scripts/heal-desynced-ledger-voids.ts --apply --include-deliberate
import "dotenv/config";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { SYNC_ACTOR_ID } from "../apps/api/src/modules/owner-ledger/owner-ledger.sync";
import { resolveSystemActor } from "../apps/api/src/modules/billing/auto-draft.repository";
import { recordAudit } from "../apps/api/src/lib/audit";

type Db = ReturnType<typeof getDb>;

export type HealResult = {
  candidateIds: string[];
  /** Ids actually healed this run — EXCLUDES deliberateVoidIds unless includeDeliberate was passed. */
  healedIds: string[];
  /** Candidates that ALSO carry a deliberate owner_ledger.entry.void AuditLog — excluded from healedIds by default; reported either way. */
  deliberateVoidIds: string[];
};

export type HealCandidateRow = {
  id: string;
  organizationId: string;
  sourceChargeId: string | null;
  sourceInvoiceId: string | null;
  sourceUtilityBillId: string | null;
};

/** Sync-owned rows currently voided — the pre-liveness-filter candidate pool. */
export async function findVoidedSyncOwnedRows(db: Db): Promise<HealCandidateRow[]> {
  return db.ownerLedgerEntry.findMany({
    where: { status: "void", updatedById: SYNC_ACTOR_ID },
    select: {
      id: true,
      organizationId: true,
      sourceChargeId: true,
      sourceInvoiceId: true,
      sourceUtilityBillId: true,
    },
  });
}

/**
 * Of `rows`, the ones healable right now — mirrors the Task-9 reverse-pass
 * dead-source predicate in owner-ledger.sync.ts (~766-793) EXACTLY, inverted:
 * a row is healable iff NONE of its (at most one non-null per kind) source
 * refs is dead.
 */
export async function filterHealable(db: Db, rows: HealCandidateRow[]): Promise<HealCandidateRow[]> {
  const chargeIds = [...new Set(rows.map((r) => r.sourceChargeId).filter((v): v is string => v !== null))];
  const invoiceIds = [...new Set(rows.map((r) => r.sourceInvoiceId).filter((v): v is string => v !== null))];
  const billIds = [...new Set(rows.map((r) => r.sourceUtilityBillId).filter((v): v is string => v !== null))];
  const [deadCharges, deadInvoices, deadBills] = await Promise.all([
    chargeIds.length
      ? db.charge.findMany({
          where: { id: { in: chargeIds }, status: { in: ["void", "credited"] } },
          select: { id: true },
        })
      : Promise.resolve([]),
    invoiceIds.length
      ? db.invoice.findMany({ where: { id: { in: invoiceIds }, status: "void" }, select: { id: true } })
      : Promise.resolve([]),
    billIds.length
      ? db.unitUtilityBill.findMany({ where: { id: { in: billIds }, status: "void" }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const deadChargeSet = new Set(deadCharges.map((c) => c.id));
  const deadInvoiceSet = new Set(deadInvoices.map((i) => i.id));
  const deadBillSet = new Set(deadBills.map((b) => b.id));

  return rows.filter((r) => {
    const chargeDead = r.sourceChargeId !== null && deadChargeSet.has(r.sourceChargeId);
    const invoiceDead = r.sourceInvoiceId !== null && deadInvoiceSet.has(r.sourceInvoiceId);
    const billDead = r.sourceUtilityBillId !== null && deadBillSet.has(r.sourceUtilityBillId);
    return !chargeDead && !invoiceDead && !billDead;
  });
}

/**
 * OVER-HEAL MITIGATION (review Finding 1, hardened by Finding 2). Of
 * `candidateIds`, the ones that ALSO carry a deliberate manual-void AuditLog —
 * action "owner_ledger.entry.void", exactly what the pre-R3 voidEntry path
 * wrote when an admin voided the row on purpose. `healDesyncedLedgerVoids`
 * EXCLUDES these ids from the healed set by default (blind-healing a
 * deliberately-voided duplicate would re-inflate the owner's payout) — pass
 * `includeDeliberate: true` (CLI: `--include-deliberate`) to heal them anyway
 * after review. This function itself only ever reports; the exclusion is
 * applied by the caller.
 */
export async function findDeliberateVoidIds(db: Db, candidateIds: string[]): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const audits = await db.auditLog.findMany({
    where: {
      action: "owner_ledger.entry.void",
      entityType: "OwnerLedgerEntry",
      entityId: { in: candidateIds },
    },
    select: { entityId: true },
  });
  return [...new Set(audits.map((a) => a.entityId))];
}

/**
 * Write gate (mirrors sweep-orphaned-ledger-entries.ts): BOTH the `--apply` CLI
 * flag AND HEAL_CONFIRM=yes must be present. Anything else (neither, either
 * alone, or HEAL_CONFIRM set to something other than the literal "yes") stays in
 * DRY-RUN mode.
 */
export function guardsSatisfied(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--apply") && env.HEAL_CONFIRM === "yes";
}

/**
 * Applies the heal write to exactly the given rows, per-row, RE-ASSERTING the
 * full guard (status="void" AND updatedById=SYNC_ACTOR_ID) in the WHERE — a
 * row that changed between selection and write (a genuine admin void, or the
 * reverse pass legitimately voiding it for real in the interim) is safely
 * skipped rather than blindly resurrected. WRITES ONLY status (never
 * updatedById — R6). Each successful heal writes a per-row AuditLog
 * (owner_ledger.entry.heal_desync) in the SAME transaction, attributed to a
 * REAL org admin (AuditLog.actorUserId is a non-null FK — the sentinel can't be
 * used); a row whose org has no admin user is SKIPPED (never healed un-audited),
 * mirroring the sibling sweep. Returns the ids ACTUALLY healed (a subset of
 * `rows` when a race excluded one, or no admin was resolvable).
 */
export async function applyHeal(db: Db, rows: HealCandidateRow[]): Promise<string[]> {
  const healedIds: string[] = [];
  for (const row of rows) {
    const actor = await resolveSystemActor(row.organizationId);
    if (!actor) {
      // eslint-disable-next-line no-console
      console.warn(`SKIP ${row.id}: org ${row.organizationId} has no admin user for audit attribution`);
      continue;
    }
    let healed = false;
    await db.$transaction(async (tx) => {
      const result = await tx.ownerLedgerEntry.updateMany({
        where: { id: row.id, status: "void", updatedById: SYNC_ACTOR_ID },
        data: { status: "active" },
      });
      if (result.count !== 1) return; // raced away between selection and write — no heal, no audit
      await recordAudit(tx, {
        organizationId: row.organizationId,
        actorUserId: actor.actorUserId, // REAL actor (User FK) — never the sentinel
        actorRole: actor.actorRole,
        action: "owner_ledger.entry.heal_desync",
        entityType: "OwnerLedgerEntry",
        entityId: row.id,
        meta: {
          heal: true,
          before: "void",
          after: "active",
          sourceChargeId: row.sourceChargeId,
          sourceInvoiceId: row.sourceInvoiceId,
          sourceUtilityBillId: row.sourceUtilityBillId,
        } as unknown as Prisma.InputJsonValue,
      });
      healed = true;
    });
    if (healed) {
      healedIds.push(row.id);
      // eslint-disable-next-line no-console
      console.log(`healed ${row.id}`);
    }
  }
  return healedIds;
}

/**
 * Finds every bug-victim OwnerLedgerEntry row and — unless dryRun — heals it.
 * See the file header for the exact predicate. Always cross-references
 * candidates against deliberate-void AuditLogs (returned as `deliberateVoidIds`)
 * so the caller can surface them for review, dry-run or not.
 *
 * MONEY-SAFE DEFAULT (review Finding 2): candidates carrying a deliberate-void
 * AuditLog are EXCLUDED from the write unless `opts.includeDeliberate` is
 * true — a bare `--apply` never re-inflates a duplicate an admin voided on
 * purpose. `deliberateVoidIds` is still returned in full either way (healed or
 * not) so the caller can report on them.
 */
export async function healDesyncedLedgerVoids(
  db: Db,
  opts: { dryRun: boolean; includeDeliberate?: boolean } = { dryRun: false },
): Promise<HealResult> {
  const voided = await findVoidedSyncOwnedRows(db);
  const healable = await filterHealable(db, voided);
  const candidateIds = healable.map((r) => r.id);
  const deliberateVoidIds = await findDeliberateVoidIds(db, candidateIds);

  if (opts.dryRun || candidateIds.length === 0) {
    return { candidateIds, healedIds: [], deliberateVoidIds };
  }

  const flagged = new Set(deliberateVoidIds);
  const toHeal = opts.includeDeliberate ? healable : healable.filter((r) => !flagged.has(r.id));

  const healedIds = await applyHeal(db, toHeal);
  return { candidateIds, healedIds, deliberateVoidIds };
}

async function main() {
  const applyRequested = process.argv.includes("--apply");
  const confirmed = process.env.HEAL_CONFIRM === "yes";
  const dryRun = !guardsSatisfied(process.argv, process.env);
  const includeDeliberate = process.argv.includes("--include-deliberate");
  const db = getDb();

  // ALWAYS run a dry-run report pass first so the deliberate-void warning is
  // printed BEFORE any write happens — even on a direct --apply invocation.
  const { candidateIds, deliberateVoidIds } = await healDesyncedLedgerVoids(db, {
    dryRun: true,
    includeDeliberate,
  });

  const flagged = new Set(deliberateVoidIds);
  console.log(`\nDesynced shallow-void ledger rows to heal: ${candidateIds.length}`);
  for (const id of candidateIds) {
    console.log(`  ${id}${flagged.has(id) ? "   ⚠️ deliberate-void AuditLog" : ""}`);
  }

  if (deliberateVoidIds.length > 0) {
    console.log(
      `\n⚠️  ${deliberateVoidIds.length} of ${candidateIds.length} candidate(s) carry a deliberate-void ` +
        `AuditLog (action="owner_ledger.entry.void") — ` +
        (includeDeliberate
          ? `--include-deliberate passed: these WILL be healed too:`
          : `EXCLUDED by default — pass --include-deliberate to heal them too:`),
    );
    for (const id of deliberateVoidIds) console.log(`  ⚠️ ${id}`);
  }

  if (dryRun) {
    console.log(
      `\nDRY-RUN ONLY — no writes made (apply=${applyRequested}, HEAL_CONFIRM=${confirmed ? "yes" : "unset"}). ` +
        `To heal: HEAL_CONFIRM=yes node_modules/.bin/tsx scripts/heal-desynced-ledger-voids.ts --apply (both required).`,
    );
    return;
  }

  const { healedIds } = await healDesyncedLedgerVoids(db, { dryRun: false, includeDeliberate });
  const eligible = includeDeliberate ? candidateIds.length : candidateIds.length - deliberateVoidIds.length;
  console.log(
    `\nHealed: ${healedIds.length}/${eligible} rows set to status="active" ` +
      `(updatedById unchanged; each write audited as owner_ledger.entry.heal_desync).`,
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getDb().$disconnect();
    });
}
