import Decimal from "decimal.js";
import type { ExistingClaimsOnKeyResponse } from "@kason/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getExistingClaimsOnKey(
  tx: any, // match codebase convention — Prisma.TransactionClient | PrismaClient
  orgId: string,
  key: {
    propertyId: string;
    unitCode: string;
    roomType: string;
    moveInDate: Date;
  },
): Promise<ExistingClaimsOnKeyResponse> {
  const agg = await tx.commissionClaimItem.aggregate({
    _sum: { commissionPercentage: true },
    _count: { id: true },
    where: {
      organizationId: orgId,
      propertyId: key.propertyId,
      unitCode: key.unitCode,
      roomType: key.roomType,
      moveInDate: key.moveInDate,
      claim: { status: { in: ["submitted", "approved", "paid", "amended"] } },
    },
  });
  const taAgg = await tx.commissionClaimItem.aggregate({
    _sum: { taSharePercent: true },
    where: {
      organizationId: orgId,
      propertyId: key.propertyId,
      unitCode: key.unitCode,
      roomType: key.roomType,
      moveInDate: key.moveInDate,
      claim: {
        status: { in: ["submitted", "approved", "paid", "amended"] },
        claimType: { in: ["tenant_portion", "tenant_listing_portion"] },
      },
    },
  });
  const taTotal = new Decimal(taAgg._sum.taSharePercent ?? 0);
  const taRemaining = Decimal.max(0, new Decimal(100).minus(taTotal));
  const cobrokeCount = await tx.commissionClaimItem.count({
    where: {
      organizationId: orgId,
      propertyId: key.propertyId,
      unitCode: key.unitCode,
      roomType: key.roomType,
      moveInDate: key.moveInDate,
      isCobroke: true,
      claim: { status: { in: ["submitted", "approved", "paid", "amended"] } },
    },
  });
  const total = new Decimal(agg._sum.commissionPercentage ?? 0);
  const remaining = Decimal.max(0, new Decimal(100).minus(total));
  return {
    count: agg._count.id,
    totalAllocatedPct: total.toFixed(2),
    remainingPct: remaining.toFixed(2),
    hasCobrokePartner: cobrokeCount > 0,
    totalTaAllocatedPct: taTotal.toFixed(2),
    remainingTaPct: taRemaining.toFixed(2),
  };
}
