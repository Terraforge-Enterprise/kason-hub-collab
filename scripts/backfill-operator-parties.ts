// scripts/backfill-operator-parties.ts
// CREATE-only. No row deletion. Idempotent. Safe to re-run.
//
// For every User with userType="operator" AND partyId IS NULL, create a
// paired Party row (partyType="individual", displayName=fullName,
// primaryEmail=email, status="active") and link User.partyId to it.
//
// Without a Party row, operator users (admin/manager/editor/viewer) don't
// appear in the /parties/assignable picker — the Listing in-charge field
// can't address them. Client report 2026-05-24.

import "dotenv/config";
import { db } from "@kason/db";

async function main() {
  try {
    const orphans = await db.user.findMany({
      where: { userType: "operator", partyId: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        organizationId: true,
        role: true,
      },
    });

    if (orphans.length === 0) {
      console.log("No operator users without a Party. Nothing to do.");
      return;
    }

    console.log(`Found ${orphans.length} operator user(s) missing a Party.`);

    let linked = 0;
    for (const u of orphans) {
      await db.$transaction(async (tx) => {
        const party = await tx.party.create({
          data: {
            organizationId: u.organizationId,
            partyType: "individual",
            displayName: u.fullName,
            primaryEmail: u.email,
            status: "active",
          },
          select: { id: true },
        });
        await tx.user.update({
          where: { id: u.id },
          data: { partyId: party.id },
        });
        console.log(
          `[${u.organizationId}] ${u.role} "${u.fullName}" <${u.email}> -> party ${party.id}`,
        );
      });
      linked++;
    }

    console.log(`Done. Linked ${linked} user(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
