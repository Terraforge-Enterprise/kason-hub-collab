import { getDb } from "@kason/db";

export async function runReservationSweeper(): Promise<{ expired: number }> {
  const db = getDb();
  const result = await db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string; organizationId: string }[]>`
      UPDATE "UnitReservation"
         SET "status" = 'expired', "updatedAt" = NOW()
       WHERE "status" = 'pending_customer'
         AND "expiresAt" < NOW()
      RETURNING "id", "organizationId"
    `;

    for (const r of due) {
      await tx.unitReservationTransition.create({
        data: {
          organizationId: r.organizationId,
          reservationId: r.id,
          fromStatus: "pending_customer",
          toStatus: "expired",
          actor: "system:sweeper",
        },
      });
    }

    return due.length;
  });

  return { expired: result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReservationSweeper().then((r) => {
    // eslint-disable-next-line no-console
    console.log(`[reservation-sweeper] expired ${r.expired} reservations`);
    process.exit(0);
  });
}
