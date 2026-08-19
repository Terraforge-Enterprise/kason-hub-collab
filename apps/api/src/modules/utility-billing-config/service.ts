import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { UtilityBillingConfigInput } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import type { SessionPayload } from "../../lib/auth";

export async function getUtilityBillingConfigService(
  session: SessionPayload,
): Promise<{ subsidyPerPax: string }> {
  const row = await getDb().utilityBillingConfig.findFirst({
    where: { organizationId: session.orgId },
  });
  return { subsidyPerPax: row ? row.subsidyPerPax.toFixed(2) : "50.00" };
}

export async function upsertUtilityBillingConfigService(
  session: SessionPayload,
  input: UtilityBillingConfigInput,
): Promise<{ subsidyPerPax: string }> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const row = await tx.utilityBillingConfig.upsert({
      where: { organizationId: session.orgId },
      create: {
        organizationId: session.orgId,
        subsidyPerPax: input.subsidyPerPax,
      },
      update: {
        subsidyPerPax: input.subsidyPerPax,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.role,
      action: "meter.config.update",
      entityType: "UtilityBillingConfig",
      entityId: row.id,
      diff: { after: input } as unknown as Prisma.InputJsonValue,
    });
    return { subsidyPerPax: input.subsidyPerPax };
  });
}
