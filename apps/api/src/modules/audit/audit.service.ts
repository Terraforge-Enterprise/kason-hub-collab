import type { Prisma } from "@kason/db";
import { getDb } from "@kason/db";
import { atLeast, type AdminRole } from "../../lib/rbac";
import { runtimeConfig } from "../../lib/runtime-config";
import { findAuditRows, purgeOlderThan } from "./audit.repository";
import type { ListAuditQuery } from "./audit.types";
import { enrichAuditRows } from "./audit-enrich";

export async function listAudit(opts: {
  orgId: string;
  role: AdminRole;
  filters: Partial<ListAuditQuery>;
  page: number;
  pageSize: number;
}) {
  if (!atLeast(opts.role, "manager")) {
    throw new Error("forbidden: audit log requires manager+");
  }

  const where: Prisma.AuditLogWhereInput = {
    organizationId: opts.orgId,
    ...(opts.filters.entityType && { entityType: opts.filters.entityType }),
    ...(opts.filters.entityId && { entityId: opts.filters.entityId }),
    ...(opts.filters.actorUserId && { actorUserId: opts.filters.actorUserId }),
    ...(opts.filters.action && { action: opts.filters.action }),
  };

  if (opts.filters.from || opts.filters.to) {
    where.createdAt = {
      ...(opts.filters.from && { gte: new Date(opts.filters.from) }),
      ...(opts.filters.to && { lte: new Date(opts.filters.to) }),
    };
  }

  const { rows, total } = await findAuditRows(where, opts.page, opts.pageSize);
  const enrichedRows = await enrichAuditRows(getDb(), rows);
  return { rows: enrichedRows, total };
}

export async function purgeExpiredAudit(
  retentionDays = runtimeConfig.limits.auditRetentionDays,
) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return purgeOlderThan(cutoff);
}
