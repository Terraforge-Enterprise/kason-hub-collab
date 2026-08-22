/** Project partial and full tenant deposit collections into owner payout. */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

const LEG_BY_CHARGE_TYPE: Record<string, "rental" | "utilities"> = {
  security_deposit: "rental",
  utility_deposit: "utilities",
};
const money = (value: Prisma.Decimal | string | number): number =>
  Math.round(Number(value.toString()) * 100) / 100;

async function recordProjectionIssue(
  ctx: OwnerBillingActorCtx,
  entityId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await getDb().$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        action: "owner-billing.deposit_payable_to_owner.failed",
        entityType: "Deposit",
        entityId,
        meta,
      }),
    );
  } catch {
    // This projection must never roll back a payment.
  }
}

/**
 * Despite its legacy name, this records deposits payable to the owner. Each
 * invocation inserts only the delta between net posted allocations and amounts
 * already released. A later reversal writes a negative correction, keeping the
 * owner payout accurate without mutating historical financial rows.
 */
export async function recordDepositsPayableToOwnerForPaidCharges(
  orgId: string,
  userId: string,
  role: string,
  chargeIds: string[] | null | undefined,
): Promise<void> {
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING") || !chargeIds?.length) return;
  const ctx: OwnerBillingActorCtx = {
    orgId,
    actorUserId: userId,
    actorRole: role as OwnerBillingActorCtx["actorRole"],
  };

  try {
    const db = getDb();
    const charges = await db.charge.findMany({
      where: {
        organizationId: orgId,
        id: { in: chargeIds },
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: { notIn: ["void", "credited"] },
      },
      select: {
        id: true,
        tenancyId: true,
        unitId: true,
        partyId: true,
        chargeType: true,
        allocations: {
          where: { payment: { status: "posted" } },
          select: { id: true, allocatedAmount: true },
        },
      },
    });

    for (const charge of charges) {
      if (!charge.tenancyId || !charge.unitId) continue;
      const type = LEG_BY_CHARGE_TYPE[charge.chargeType];
      if (!type) continue;

      const allocationIds = charge.allocations.map((allocation) => allocation.id);
      const reversals = allocationIds.length
        ? await db.paymentAllocationReversal.findMany({
            where: { organizationId: orgId, originalAllocationId: { in: allocationIds } },
            select: { amount: true },
          })
        : [];
      const collected = money(
        charge.allocations.reduce((sum, allocation) => sum + money(allocation.allocatedAmount), 0) -
          reversals.reduce((sum, reversal) => sum + money(reversal.amount), 0),
      );
      const existing = await db.deposit.aggregate({
        where: {
          organizationId: orgId,
          tenancyId: charge.tenancyId,
          type,
          status: "released_to_owner",
        },
        _sum: { amount: true },
      });
      const delta = money(collected - money(existing._sum.amount ?? 0));
      if (delta === 0) continue;

      await db.deposit.create({
        data: {
          organizationId: orgId,
          tenancyId: charge.tenancyId,
          partyId: charge.partyId,
          unitId: charge.unitId,
          type,
          amount: delta,
          status: "released_to_owner",
        },
      });
    }
  } catch (error) {
    await recordProjectionIssue(ctx, chargeIds[0]!, {
      chargeIds,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @deprecated Use recordDepositsPayableToOwnerForPaidCharges. */
export const recordDepositsHeldForPaidCharges = recordDepositsPayableToOwnerForPaidCharges;
