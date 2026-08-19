import type { Prisma } from "@kason/db";

const TERMINAL_STATUSES = ["cancelled", "rejected", "paid"];

/**
 * Cancels every non-terminal SalesClaim and RenovationClaim attached to
 * a SalesUnit, appends transition rows, and soft-archives the unit's
 * RenovationProgress. Called by:
 *   - source-queue reject handler (admin rejects the SalesUnit)
 *   - portal cancel handler (agent withdraws their pending entry)
 */
export async function cascadeCancelClaimsOnSalesUnitTermination(
  tx: Prisma.TransactionClient,
  salesUnitId: string,
  reason: string,
  actorUserId: string,
  orgId: string,
): Promise<void> {
  const salesClaims = await tx.salesClaim.findMany({
    where: { salesUnitId, status: { notIn: TERMINAL_STATUSES } },
    select: { id: true, status: true },
  });

  if (salesClaims.length > 0) {
    await tx.salesClaim.updateMany({
      where: { salesUnitId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: "cancelled", reviewerNote: reason },
    });
    await tx.salesClaimTransition.createMany({
      data: salesClaims.map((c) => ({
        organizationId: orgId,
        claimId: c.id,
        fromStatus: c.status,
        toStatus: "cancelled",
        changedById: actorUserId,
        note: reason,
      })),
    });
  }

  const renoClaims = await tx.renovationClaim.findMany({
    where: { salesUnitId, status: { notIn: TERMINAL_STATUSES } },
    select: { id: true, status: true },
  });

  if (renoClaims.length > 0) {
    await tx.renovationClaim.updateMany({
      where: { salesUnitId, status: { notIn: TERMINAL_STATUSES } },
      data: { status: "cancelled", reviewerNote: reason },
    });
    await tx.renovationClaimTransition.createMany({
      data: renoClaims.map((c) => ({
        organizationId: orgId,
        claimId: c.id,
        fromStatus: c.status,
        toStatus: "cancelled",
        changedById: actorUserId,
        note: reason,
      })),
    });
  }

  await tx.renovationProgress.updateMany({
    where: { salesUnitId, archivedAt: null },
    data: { archivedAt: new Date(), archivedById: actorUserId },
  });
}
