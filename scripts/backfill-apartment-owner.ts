// scripts/backfill-apartment-owner.ts
//
// Backfill the apartment-scoped owner onto already-ownerless non-archived rooms
// of apartments that already carry exactly one owner. Fixes rooms that were
// created BEFORE the owner was assigned (or added afterward) and therefore
// stayed ownerless — so they could never be occupied (UNIT_HAS_NO_OWNER) even
// though their siblings were owned and occupied.
//
// Companion to the forward-fix in apps/api/src/modules/inventory/inventory.service.ts
// (createUnitService / createUnitsBatchService now make a NEW room inherit the
// apartment's owner on creation). This script repairs rows that predate that fix.
//
// Conflict-safe: apartments whose non-archived rooms reference 2+ distinct
// owners are SKIPPED and reported — never guessed. Resolve those manually first
// (see report-split-owner-apartments.ts). Carparks are out of scope (rooms only).
//
// Dry-run by DEFAULT. Pass --apply to write. Prints the target DB (masked).
// Idempotent + re-run safe: the apply UPDATE only touches still-null rooms.
//
//   Preview:  DATABASE_URL=... npx tsx scripts/backfill-apartment-owner.ts
//   Apply:    DATABASE_URL=... npx tsx scripts/backfill-apartment-owner.ts --apply

import "dotenv/config";
import { db } from "@kason/db";

export type BackfillRoom = {
  id: string;
  apartmentId: string;
  ownerPartyId: string | null;
};

export type BackfillPlan = {
  backfills: { apartmentId: string; ownerPartyId: string; roomIds: string[] }[];
  conflicts: { apartmentId: string; owners: string[] }[];
};

/**
 * Pure planner. Groups non-archived rooms by apartment and decides, per
 * apartment:
 *   - 2+ distinct owners            → CONFLICT (skip; manual resolution).
 *   - exactly 1 owner + ownerless   → backfill those ownerless rooms to it.
 *   - 0 owners, or already consistent → no-op.
 */
export function planApartmentOwnerBackfill(rooms: BackfillRoom[]): BackfillPlan {
  const byApartment = new Map<string, { owners: Set<string>; ownerless: string[] }>();
  for (const r of rooms) {
    const slot = byApartment.get(r.apartmentId) ?? { owners: new Set<string>(), ownerless: [] };
    if (r.ownerPartyId) slot.owners.add(r.ownerPartyId);
    else slot.ownerless.push(r.id);
    byApartment.set(r.apartmentId, slot);
  }

  const backfills: BackfillPlan["backfills"] = [];
  const conflicts: BackfillPlan["conflicts"] = [];
  for (const [apartmentId, v] of byApartment) {
    if (v.owners.size > 1) {
      conflicts.push({ apartmentId, owners: [...v.owners] });
    } else if (v.owners.size === 1 && v.ownerless.length > 0) {
      backfills.push({ apartmentId, ownerPartyId: [...v.owners][0]!, roomIds: v.ownerless });
    }
  }
  return { backfills, conflicts };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const masked = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]*@/, ":****@");
  console.log(`[backfill-apartment-owner] target DB: ${masked || "(DATABASE_URL unset)"}`);
  console.log(
    `[backfill-apartment-owner] mode: ${apply ? "APPLY (writing)" : "DRY-RUN (no writes — pass --apply to write)"}`,
  );

  try {
    const rooms = await db.listing.findMany({
      where: { listingStatus: { not: "archived" } },
      select: {
        id: true,
        apartmentId: true,
        ownerPartyId: true,
        apartment: { select: { unitCode: true } },
      },
    });

    const unitCodeByApartment = new Map<string, string>();
    for (const r of rooms) unitCodeByApartment.set(r.apartmentId, r.apartment.unitCode);

    const plan = planApartmentOwnerBackfill(
      rooms.map(
        (r): BackfillRoom => ({ id: r.id, apartmentId: r.apartmentId, ownerPartyId: r.ownerPartyId }),
      ),
    );

    const roomsToFix = plan.backfills.reduce((n, b) => n + b.roomIds.length, 0);
    console.log(
      `\nScanned ${rooms.length} non-archived room(s) across ${unitCodeByApartment.size} apartment(s).`,
    );
    console.log(
      `Backfill plan: ${plan.backfills.length} apartment(s), ${roomsToFix} ownerless room(s) to fix.`,
    );
    for (const b of plan.backfills) {
      console.log(
        `  ${unitCodeByApartment.get(b.apartmentId)} (apt ${b.apartmentId}) → owner ${b.ownerPartyId} onto ${b.roomIds.length} room(s): [${b.roomIds.join(", ")}]`,
      );
    }

    if (plan.conflicts.length > 0) {
      console.log(
        `\n⚠ SKIPPED ${plan.conflicts.length} split-owner apartment(s) (2+ distinct owners — resolve manually, see report-split-owner-apartments.ts):`,
      );
      for (const c of plan.conflicts) {
        console.log(
          `  ${unitCodeByApartment.get(c.apartmentId)} (apt ${c.apartmentId}) — owners: [${c.owners.join(", ")}]`,
        );
      }
    }

    if (!apply) {
      console.log(`\nDry-run complete. No rows written. Re-run with --apply to backfill.`);
      return;
    }
    if (plan.backfills.length === 0) {
      console.log(`\nNothing to backfill. Done.`);
      return;
    }

    let updated = 0;
    for (const b of plan.backfills) {
      // Idempotent + defence-in-depth: only fill rooms that are STILL ownerless
      // and non-archived at write time (a concurrent assignment wins, never lost).
      const res = await db.listing.updateMany({
        where: { id: { in: b.roomIds }, ownerPartyId: null, listingStatus: { not: "archived" } },
        data: { ownerPartyId: b.ownerPartyId },
      });
      updated += res.count;
    }
    console.log(`\n✅ Backfilled ${updated} room(s) across ${plan.backfills.length} apartment(s).`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
