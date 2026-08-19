import { recordAudit } from "../../lib/audit";
import type { ImportSession } from "./types";

/**
 * Idempotent find-or-create of a CarparkAssignment inside an open transaction.
 *
 * Guards on (org, carparkId, tenancyId, status="active") — safe to call on
 * re-import. When a new assignment is created, the bay's status is flipped
 * from "available" to "rented". When the assignment already exists (re-run),
 * no database writes are issued.
 */
export async function ensureCarparkAssignment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  session: ImportSession,
  carparkId: string,
  tenancyId: string,
  monthlyCharge: number,
): Promise<{ created: boolean; assignmentId: string }> {
  const existing = await tx.carparkAssignment.findFirst({
    where: {
      organizationId: session.orgId,
      carparkId,
      tenancyId,
      status: "active",
    },
    select: { id: true },
  });
  if (existing) return { created: false, assignmentId: existing.id };

  const assignment = await tx.carparkAssignment.create({
    data: {
      organizationId: session.orgId,
      carparkId,
      tenancyId,
      monthlyCharge: monthlyCharge.toString(),
      startDate: new Date(),
      status: "active",
    },
    select: { id: true },
  });

  await tx.carpark.update({
    where: { id: carparkId },
    data: { status: "rented" },
  });

  await recordAudit(tx, {
    organizationId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role,
    action: "data-import.carpark.assign",
    entityType: "CarparkAssignment",
    entityId: assignment.id,
    meta: { source: "data-import", carparkId, tenancyId },
  });

  return { created: true, assignmentId: assignment.id };
}
