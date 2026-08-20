import { getDb } from "@kason/db";

type Db = ReturnType<typeof getDb>;

export type RawAuditRow = {
  id: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  ip: string | null;
  userAgent: string | null;
  diff: unknown;
  meta: unknown;
  createdAt: Date;
};

export type EnrichedAuditRow = {
  id: string;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceName: string | null;
  diff: unknown;
  meta: unknown;
  createdAt: string;
};

/** Leftmost IP of a comma-separated x-forwarded-for chain (the original client). */
export function primaryIp(ip: string | null): string | null {
  if (!ip) return null;
  const first = ip.split(",")[0]?.trim();
  return first ? first : null;
}

/** Friendly "Browser · OS" from a User-Agent string (no external dependency). */
export function parseUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua) && !/Chromium/.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua) && !/Chrome/.test(ua)
            ? "Safari"
            : null;
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? "Unknown device";
}

function toMap<T extends { id: string }>(rows: T[], name: (r: T) => string | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const n = name(r);
    if (n) m.set(r.id, n);
  }
  return m;
}

type Resolver = (db: Db, ids: string[]) => Promise<Map<string, string>>;

// entityType → resolver. Each closure is independently typed against its model.
const RESOLVERS: Record<string, Resolver> = {
  Task: async (db, ids) => toMap(await db.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }), (r) => r.title),
  Sprint: async (db, ids) => toMap(await db.sprint.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, seq: true } }), (r) => r.name ?? `Sprint ${r.seq}`),
  Ticket: async (db, ids) => toMap(await db.ticket.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }), (r) => r.title),
  TicketHistory: async (db, ids) => toMap(await db.ticketHistory.findMany({ where: { id: { in: ids } }, select: { id: true, entry: true } }), (r) => r.entry.slice(0, 60)),
  Party: async (db, ids) => toMap(await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }), (r) => r.displayName),
  CommissionClaim: async (db, ids) => toMap(await db.commissionClaim.findMany({ where: { id: { in: ids } }, select: { id: true, claimNumber: true } }), (r) => r.claimNumber),
  Invoice: async (db, ids) => toMap(await db.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true } }), (r) => r.invoiceNumber),
  Payment: async (db, ids) => toMap(await db.payment.findMany({ where: { id: { in: ids } }, select: { id: true, paymentNumber: true } }), (r) => r.paymentNumber),
  Charge: async (db, ids) => toMap(await db.charge.findMany({ where: { id: { in: ids } }, select: { id: true, chargeNumber: true } }), (r) => r.chargeNumber),
  Property: async (db, ids) => toMap(await db.property.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (r) => r.name),
  Apartment: async (db, ids) => toMap(await db.apartment.findMany({ where: { id: { in: ids } }, select: { id: true, unitCode: true } }), (r) => r.unitCode),
  Tenancy: async (db, ids) => toMap(await db.tenancy.findMany({ where: { id: { in: ids } }, select: { id: true, tenancyCode: true } }), (r) => r.tenancyCode),
  Organization: async (db, ids) => toMap(await db.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (r) => r.name),
  User: async (db, ids) => toMap(await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }), (r) => r.fullName),
  AircondMeter: async (db, ids) => toMap(await db.aircondMeter.findMany({ where: { id: { in: ids } }, select: { id: true, meterNumber: true } }), (r) => r.meterNumber),
  UnitReservation: async (db, ids) => toMap(await db.unitReservation.findMany({ where: { id: { in: ids } }, select: { id: true, referenceCode: true } }), (r) => r.referenceCode),
  UnitSubmission: async (db, ids) => toMap(await db.unitSubmission.findMany({ where: { id: { in: ids } }, select: { id: true, unitCode: true } }), (r) => r.unitCode),
  PropertySubmission: async (db, ids) => toMap(await db.propertySubmission.findMany({ where: { id: { in: ids } }, select: { id: true, propertyCode: true } }), (r) => r.propertyCode),
  RenovationPackage: async (db, ids) => toMap(await db.renovationPackage.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } }), (r) => r.label),
  AgentCardVersion: async (db, ids) => toMap(await db.agentCardVersion.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }), (r) => r.displayName),
  RenovationClaimDocument: async (db, ids) => toMap(await db.renovationClaimDocument.findMany({ where: { id: { in: ids } }, select: { id: true, filename: true } }), (r) => r.filename),
};

async function resolveEntityNames(db: Db, rows: RawAuditRow[]): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!RESOLVERS[r.entityType]) continue;
    let set = byType.get(r.entityType);
    if (!set) {
      set = new Set();
      byType.set(r.entityType, set);
    }
    set.add(r.entityId);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...byType.entries()].map(async ([type, idSet]) => {
      const resolved = await RESOLVERS[type](db, [...idSet]);
      for (const [id, name] of resolved) out.set(`${type}:${id}`, name);
    }),
  );
  return out;
}

export async function enrichAuditRows(db: Db, rows: RawAuditRow[]): Promise<EnrichedAuditRow[]> {
  const actorIds = [...new Set(rows.map((r) => r.actorUserId))];
  const actors = actorIds.length
    ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
    : [];
  const actorNames = new Map(actors.map((u) => [u.id, u.fullName]));
  const entityNames = await resolveEntityNames(db, rows);

  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    actorName: actorNames.get(r.actorUserId) ?? null,
    actorRole: r.actorRole,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityName: entityNames.get(`${r.entityType}:${r.entityId}`) ?? null,
    ip: primaryIp(r.ip),
    userAgent: r.userAgent,
    deviceName: parseUserAgent(r.userAgent),
    diff: r.diff,
    meta: r.meta,
    createdAt: r.createdAt.toISOString(),
  }));
}
