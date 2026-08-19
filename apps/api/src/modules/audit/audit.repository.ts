import { getDb, Prisma } from "@kason/db";

export async function findAuditRows(
  where: Prisma.AuditLogWhereInput,
  page: number,
  pageSize: number,
) {
  const db = getDb();
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count({ where }),
  ]);
  return { rows, total };
}

export async function purgeOlderThan(cutoff: Date) {
  return getDb().auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
