// scripts/backfill-unit-month-ledger.ts
//
// Idempotent backfill: for every (org, owner, statementMonth) with active
// OwnerLedgerEntry rows, run materializeOwnerUnitMonths. Re-runnable.
//
// Organisations that have no admin user are skipped (logged once, not an error).
//
//   DATABASE_URL=... npx tsx scripts/backfill-unit-month-ledger.ts

import "dotenv/config";
import { getDb } from "@kason/db";
import { resolveSystemActor } from "../apps/api/src/modules/billing/auto-draft.repository";
import { materializeOwnerUnitMonths } from "../apps/api/src/modules/owner-ledger/unit-month-ledger.materialize";
import type { AdminRole } from "../apps/api/src/lib/rbac";

async function main() {
  const db = getDb();
  const pairs = await db.ownerLedgerEntry.groupBy({
    by: ["organizationId", "ownerPartyId", "statementMonth"],
    where: { status: "active" },
  });
  console.log(`[backfill] ${pairs.length} (org,owner,month) partitions`);
  let ok = 0,
    skipped = 0;
  // null = "checked, no admin" (negative cache) so resolveSystemActor is called
  // at most once per org and the no-admin message is logged once, not per partition.
  const actorByOrg = new Map<string, { actorUserId: string; actorRole: AdminRole } | null>();
  for (const p of pairs) {
    if (!actorByOrg.has(p.organizationId)) {
      const resolved = await resolveSystemActor(p.organizationId);
      actorByOrg.set(p.organizationId, resolved ?? null);
      if (!resolved)
        console.error(
          `[backfill] org ${p.organizationId}: no admin — all its partitions will be skipped`,
        );
    }
    const actor = actorByOrg.get(p.organizationId);
    if (!actor) {
      skipped++;
      continue;
    }
    const month = `${p.statementMonth.getUTCFullYear()}-${String(
      p.statementMonth.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    const r = await materializeOwnerUnitMonths(
      { orgId: p.organizationId, actorUserId: actor.actorUserId, actorRole: actor.actorRole },
      p.ownerPartyId,
      month,
    );
    ok += r.upserted;
  }
  console.log(`[backfill] done: ${ok} rows upserted, ${skipped} partitions skipped`);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
