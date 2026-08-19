// scripts/backfill-void-owner-ledger-utility-twins.ts
//
// ONE-TIME REVERSIBLE BACKFILL (owner-ledger view clarity, Approach B, spec
// 2026-07-06): void the vestigial display-only utility "statement twin"
// OwnerLedgerEntry rows that Task 1 stopped creating. Voids (never deletes) ONLY the
// payout-invariant twins — active statement-sourced EXPENSE rows in the four
// display-only utility categories with includeInPayout:false — so they stop showing as
// duplicates and stop inflating displayed totals WITHOUT changing any payout. Rows with
// includeInPayout:true are LEFT untouched (their money direction is per-row
// history-dependent — voiding a sole-deduction row would OVERPAY the owner). Dry-run by
// default; every live pass prints the target DB and requires --confirm.
//
//   npx tsx scripts/backfill-void-owner-ledger-utility-twins.ts                 # dry-run
//   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx ... --apply --confirm           # live void
//   DATABASE_URL=$SUPABASE_DATABASE_URL npx tsx ... --undo  --confirm           # reverse (audit-driven)
//   ... --org <organizationId>                                                  # scope to one org
import "dotenv/config";
import { db } from "@kason/db";
import { resolveSystemActor } from "../apps/api/src/modules/billing/auto-draft.repository";
import { recordAudit } from "../apps/api/src/lib/audit";
import { SYNC_ACTOR_ID } from "../apps/api/src/modules/owner-ledger/owner-ledger.sync";

const DISPLAY_ONLY = ["utilities_tnb", "wifi", "indah_water", "water"] as const;
const ACTION = "owner_ledger.entry.void_vestigial_twin";
const UNVOID_ACTION = "owner_ledger.entry.unvoid_vestigial_twin";

export interface BackfillOpts {
  apply?: boolean;
  confirm?: boolean;
  undo?: boolean;
  org?: string;
}
export interface BackfillResult {
  voided: number;
  reactivated: number;
  skippedNoAdmin: number;
  matched: number;
}

export async function runBackfill(opts: BackfillOpts): Promise<BackfillResult> {
  const res: BackfillResult = { voided: 0, reactivated: 0, skippedNoAdmin: 0, matched: 0 };
  const orgs = await db.organization.findMany({
    where: opts.org ? { id: opts.org } : {},
    select: { id: true },
  });
  for (const org of orgs) {
    if (opts.undo) {
      // Reverse THIS backfill only: read its own void_vestigial_twin audit rows and
      // re-activate the referenced entities that are STILL void. Driven by the audit
      // trail (NOT a status-only predicate) so a row voided by anything else — e.g.
      // the sync reverse-pass — is never reclaimed. Re-activating an already-active
      // row is a no-op, so a double-undo naturally reactivates nothing.
      const audits = await db.auditLog.findMany({
        where: { organizationId: org.id, action: ACTION },
        select: { entityId: true },
      });
      const ids = [...new Set(audits.map((a) => a.entityId))];
      const stillVoid = ids.length
        ? await db.ownerLedgerEntry.findMany({
            where: { id: { in: ids }, status: "void" },
            select: { id: true },
          })
        : [];
      res.matched += stillVoid.length;
      if (!opts.confirm) continue; // undo is a live pass → requires --confirm
      if (stillVoid.length === 0) continue; // nothing to reactivate — skip the actor lookup
      // Same actor-resolution + no-admin skip as the void path: AuditLog.actorUserId
      // is a non-null User FK, so with no real admin we cannot write the mandatory
      // unvoid audit row → skip the org (counted) rather than reactivate silently
      // with no traceable actor.
      const actor = await resolveSystemActor(org.id);
      if (!actor) {
        res.skippedNoAdmin += 1;
        continue;
      }
      for (const row of stillVoid) {
        await db.$transaction(async (tx) => {
          await tx.ownerLedgerEntry.update({
            where: { id: row.id },
            data: { status: "active", updatedById: SYNC_ACTOR_ID },
          });
          await recordAudit(tx, {
            organizationId: org.id,
            actorUserId: actor.actorUserId,
            actorRole: actor.actorRole,
            action: UNVOID_ACTION,
            entityType: "OwnerLedgerEntry",
            entityId: row.id,
            meta: { reactivated: true },
          });
        });
        res.reactivated += 1;
      }
      continue;
    }
    // Void ONLY the payout-invariant display-only twins: active statement-sourced EXPENSE
    // rows in the 4 display-only categories with includeInPayout:false. The includeInPayout
    // filter is MONEY-CRITICAL — a statement-utility row stored includeInPayout:true has a
    // per-row, history-dependent money direction: with NO matching Source-3 utility_* full
    // bill for that owner-month it is the SOLE payout deduction, so voiding it would OVERPAY
    // the owner. Those rows (incl. pre-C1 stragglers) are LEFT for manual review, never
    // swept here. The category-gate still spares admin-edited NON-utility statement rows
    // (fire_insurance, cleaning, etc.); sourceType:"statement" spares Source-3 full-bill
    // (utility_*) rows.
    const matches = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: org.id,
        status: "active",
        sourceType: "statement",
        direction: "expense",
        includeInPayout: false,
        category: { in: [...DISPLAY_ONLY] },
      },
      select: { id: true, updatedById: true },
    });
    res.matched += matches.length;
    // Write path requires BOTH --apply AND --confirm. apply-without-confirm behaves like a
    // dry-run (count reported above, nothing written) so a programmatic caller can never
    // void money rows without an explicit confirm — mirrors the undo branch's confirm gate.
    if (!opts.apply || !opts.confirm) continue;
    const actor = await resolveSystemActor(org.id);
    if (!actor) {
      // resolveSystemActor returns null (does NOT throw) on a no-admin org. AuditLog
      // .actorUserId is a non-null User FK, so with no real admin we cannot write the
      // mandatory audit row → skip the org (counted) rather than abort the whole run.
      res.skippedNoAdmin += 1;
      continue;
    }
    for (const row of matches) {
      await db.$transaction(async (tx) => {
        await tx.ownerLedgerEntry.update({
          where: { id: row.id },
          data: { status: "void", updatedById: SYNC_ACTOR_ID },
        });
        await recordAudit(tx, {
          organizationId: org.id,
          actorUserId: actor.actorUserId,
          actorRole: actor.actorRole,
          action: ACTION,
          entityType: "OwnerLedgerEntry",
          entityId: row.id,
          meta: { adminEdited: row.updatedById !== SYNC_ACTOR_ID },
        });
      });
      res.voided += 1;
    }
  }
  return res;
}

async function main() {
  const argv = process.argv;
  const apply = argv.includes("--apply");
  const undo = argv.includes("--undo");
  const confirm = argv.includes("--confirm");
  const orgFlag = argv.indexOf("--org");
  const org = orgFlag >= 0 ? argv[orgFlag + 1] : undefined;
  // Redact the password before printing the target so the operator can eyeball
  // WHICH database this live pass would hit (local vs staging vs client-prod).
  const host = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@");
  const live = apply || undo;
  if (live) {
    console.log(`TARGET DB: ${host}`);
    if (!confirm) {
      console.error("REFUSING live pass without --confirm. Re-run with --confirm.");
      process.exit(1);
    }
  } else {
    console.log("MODE: dry-run (pass --apply --confirm to write, --undo --confirm to reverse)");
    console.log(`TARGET DB: ${host}`);
  }
  const res = await runBackfill({ apply, undo, confirm, org });
  console.log(JSON.stringify(res, null, 2));
  await db.$disconnect();
  process.exit(0); // match sibling scripts — don't let the open Prisma pool hang the CLI
}

// Auto-run as a CLI, not when imported by the integration test (repo-standard guard —
// matches all sibling scripts, e.g. backfill-charge-categories.ts).
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
