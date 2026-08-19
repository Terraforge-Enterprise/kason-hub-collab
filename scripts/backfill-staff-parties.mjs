// One-shot backfill: every operator User (userType='operator') that has
// partyId=NULL gets a freshly-created Party (partyType='individual') and a
// `User.partyId` link pointing at it.
//
// Idempotent — skips users that already have a partyId.
//
// Usage:
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kaenhub \
//     node scripts/backfill-staff-parties.mjs --apply
//
// Without --apply, runs in dry-run mode and prints what it WOULD do.
//
// DO NOT run against UAT or production without the user's explicit OK —
// CLAUDE.md hardline rule: no destructive operations against UAT outside
// `prisma migrate deploy`. This is additive, not destructive, but still
// review the dry-run output first.

import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  const orphans = await prisma.user.findMany({
    where: {
      userType: "operator",
      partyId: null,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      organizationId: true,
      status: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${orphans.length} operator user${orphans.length === 1 ? "" : "s"} with partyId=NULL`);
  for (const u of orphans) {
    console.log(`  - ${u.fullName} <${u.email}> [role=${u.role}, status=${u.status}, org=${u.organizationId}]`);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to perform the writes.");
    return;
  }

  let created = 0;
  for (const u of orphans) {
    await prisma.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: {
          organizationId: u.organizationId,
          partyType: "individual",
          displayName: u.fullName,
          primaryEmail: u.email,
          // Mirror user's status. If a deactivated operator gets backfilled,
          // the Party is also created as inactive so it stays consistent with
          // hierarchy filtering (status='active' default-shown).
          status: u.status === "active" ? "active" : "inactive",
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: u.id },
        data: { partyId: party.id },
      });
    });
    created += 1;
    console.log(`  ✓ Created Party for ${u.fullName}`);
  }

  console.log(`\nBackfill complete — created ${created} Party row${created === 1 ? "" : "s"}.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
