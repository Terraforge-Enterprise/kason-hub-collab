import { Prisma } from "@kason/db";

/**
 * Idempotent carpark-rent posting (Task 4.2).
 *
 * For every active CarparkAssignment tied to the tenancy, creates one
 * `chargeType:"carpark"` Charge with `carparkId` set and `unitId: null`.
 * Dedup key = `CARPARK-${YYYYMM}-${carparkId}` (unique per bay per month).
 *
 * Called from two sites on the SAME transaction:
 *   1. meter/service.ts chargeUtilityBillService — right after postMonthlyRentForTenancy
 *      (tracker "Post charges" action).
 *   2. auto-draft.service.ts — draft variant within the cron loop (parked feature;
 *      carpark draft charges are attached to the same invoice as rent, so
 *      recomputeInvoiceTotalTx at the end of the loop picks them up).
 *
 * Idempotency: CHECK-FIRST (not P2002-catch), for the same reason as
 * postMonthlyRentForTenancy — a unique violation inside a Prisma transaction
 * aborts the WHOLE tx (Postgres), which would also roll back the utility/rent
 * charges created alongside it.
 */

export type PostMonthlyCarparkResult = { chargeIds: string[]; created: number; skipped: number };

/** "YYYY-MM" → "YYYYMM" compact form used in charge numbers. */
function compactMonthFromDate(month: Date): string {
  return `${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
}

function firstOfMonthUtc(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
}

export function carparkChargeNumber(compactMonth: string, carparkId: string): string {
  return `CARPARK-${compactMonth}-${carparkId}`;
}

export async function postMonthlyCarparkForTenancy(
  tx: Prisma.TransactionClient,
  orgId: string,
  tenancyId: string,
  month: Date,
  actorUserId: string,
): Promise<PostMonthlyCarparkResult> {
  const cm = compactMonthFromDate(month);
  const billingMonth = firstOfMonthUtc(month);

  const tenancy = await tx.tenancy.findFirst({
    where: { id: tenancyId, organizationId: orgId },
    select: { tenantPartyId: true },
  });
  if (!tenancy) {
    throw new Error(`postMonthlyCarparkForTenancy: tenancy ${tenancyId} not found in org ${orgId}`);
  }

  const assignments = await tx.carparkAssignment.findMany({
    where: { organizationId: orgId, tenancyId, status: "active" },
    select: { carparkId: true, monthlyCharge: true },
  });

  const chargeIds: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const assignment of assignments) {
    const chargeNumber = carparkChargeNumber(cm, assignment.carparkId);

    // CHECK-FIRST dedup (tx-safe). A unique violation inside an interactive tx aborts
    // the whole transaction; we must resolve the existing-row case before inserting.
    const existing = await tx.charge.findFirst({
      where: { organizationId: orgId, chargeNumber },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status === "draft") {
        // Auto-draft created it first → flip draft→posted via a guarded WHERE (status:"draft"),
        // which is a 0-row no-op on a concurrent replay. The amount is NEVER rewritten
        // (the cron already set it; the assignment monthlyCharge is the single source).
        const flipped = await tx.charge.updateMany({
          where: { id: existing.id, organizationId: orgId, status: "draft" },
          data: { status: "posted", postedAt: new Date() },
        });
        if (flipped.count > 0) {
          await tx.chargeEvent.create({
            data: {
              organizationId: orgId,
              chargeId: existing.id,
              eventType: "charge_posted",
              eventAt: new Date(),
              actorUserId,
              payloadJson: { previousStatus: "draft", nextStatus: "posted", source: "tracker.carpark" } as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }
      // draft (just flipped) / posted / paid / void → no-op. Never rewrite a posted amount.
      chargeIds.push(existing.id);
      skipped += 1;
      continue;
    }

    const amount = assignment.monthlyCharge.toFixed(2);

    const charge = await tx.charge.create({
      data: {
        organizationId: orgId,
        chargeNumber,
        tenancyId,
        unitId: null,
        carparkId: assignment.carparkId,
        partyId: tenancy.tenantPartyId,
        chargeType: "carpark",
        status: "posted",
        postedAt: new Date(),
        description: "Carpark rent",
        dueDate: billingMonth,
        amount,
        currency: "MYR",
        outstandingAmount: amount,
        attachmentKeys: [],
        billingMonth,
      },
      select: { id: true },
    });

    await tx.chargeEvent.create({
      data: {
        organizationId: orgId,
        chargeId: charge.id,
        eventType: "charge_created",
        eventAt: new Date(),
        actorUserId,
        payloadJson: { source: "tracker.carpark", amount } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.chargeEvent.create({
      data: {
        organizationId: orgId,
        chargeId: charge.id,
        eventType: "charge_posted",
        eventAt: new Date(),
        actorUserId,
        payloadJson: { previousStatus: "draft", nextStatus: "posted" } as unknown as Prisma.InputJsonValue,
      },
    });

    chargeIds.push(charge.id);
    created += 1;
  }

  return { chargeIds, created, skipped };
}
