import type { Prisma } from "@prisma/client";

export interface RecordAuditInput {
  organizationId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  diff?: Prisma.InputJsonValue;
  // Free-form structured payload alongside `diff`. Used e.g. by
  // admin_edit_after_signing to attach the admin's mandatory `reason` to the
  // audit row without polluting the before/after diff shape. Backward-
  // compatible with existing callers (optional field).
  meta?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

/**
 * Append an audit row to `AuditLog` inside the caller's Prisma transaction.
 *
 * MUST be called inside an outer `prisma.$transaction(async (tx) => { ... })`
 * block — the audit row is part of the same transaction so if the outer
 * action rolls back, the audit row rolls back with it.
 *
 * The signature takes `Prisma.TransactionClient` (NOT `PrismaClient`) on
 * purpose: callers cannot accidentally write an audit row outside a
 * transactional scope. If you need to record audit independently of a
 * larger write, create a dedicated `$transaction` for it.
 */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  input: RecordAuditInput,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      diff: input.diff,
      meta: input.meta,
      ip: input.ip,
      userAgent: input.userAgent,
    },
  });
}
