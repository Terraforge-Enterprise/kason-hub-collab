import { getDb } from "@kason/db";
import { Decimal } from "@prisma/client/runtime/client";

// Loose client type so `findTierMapping` and `resolveTierPercentage` accept
// both the global Prisma client and a `Prisma.TransactionClient`, and so unit
// tests can pass simple mocks. Mirrors the `PrismaTx = any` convention used
// elsewhere in this module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaLike = any;

export async function getAgentDashboard(orgId: string, partyId: string) {
  const db = getDb();
  const claims = await db.commissionClaim.findMany({
    where: { organizationId: orgId, agentPartyId: partyId },
    select: { status: true, totalNettPayout: true, approvedAt: true },
  });

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  let totalEarned = 0, thisMonthEarned = 0, thisYearEarned = 0, pending = 0;

  for (const c of claims) {
    const amount = Number(c.totalNettPayout);
    if (c.status === "approved" || c.status === "paid") {
      totalEarned += amount;
      if (c.approvedAt) {
        const d = new Date(c.approvedAt);
        if (d.getFullYear() === thisYear) thisYearEarned += amount;
        if (d.getFullYear() === thisYear && d.getMonth() === thisMonth) thisMonthEarned += amount;
      }
    }
    if (c.status === "submitted") pending += amount;
  }

  return { totalEarned, thisMonthEarned, thisYearEarned, pending };
}

export async function getAgentDashboardFull(orgId: string, partyId: string) {
  const db = getDb();
  const claims = await db.commissionClaim.findMany({
    where: { organizationId: orgId, agentPartyId: partyId },
    select: {
      status: true,
      totalNettPayout: true,
      approvedAt: true,
      submittedAt: true,
      createdAt: true,
    },
  });

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  // Summary cards
  let totalEarned = 0, thisMonthEarned = 0, thisYearEarned = 0, pending = 0;

  // Status breakdown
  let pendingTotal = 0, approvedTotal = 0, paidTotal = 0;

  // Monthly breakdown map (last 12 months)
  const monthlyMap = new Map<string, number>();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(thisYear, thisMonth - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap.set(key, 0);
  }

  // Yearly breakdown map
  const yearlyMap = new Map<number, number>();

  for (const c of claims) {
    const amount = Number(c.totalNettPayout);

    // Status breakdown
    if (c.status === "submitted") { pending += amount; pendingTotal += amount; }
    if (c.status === "approved") approvedTotal += amount;
    if (c.status === "paid") paidTotal += amount;

    // Earned = approved + paid
    if (c.status === "approved" || c.status === "paid") {
      totalEarned += amount;
      if (c.approvedAt) {
        const d = new Date(c.approvedAt);
        const yr = d.getFullYear();
        const mo = d.getMonth();
        if (yr === thisYear) thisYearEarned += amount;
        if (yr === thisYear && mo === thisMonth) thisMonthEarned += amount;

        // Monthly
        const key = `${yr}-${String(mo + 1).padStart(2, "0")}`;
        if (monthlyMap.has(key)) monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + amount);

        // Yearly
        yearlyMap.set(yr, (yearlyMap.get(yr) ?? 0) + amount);
      }
    }
  }

  const monthly = Array.from(monthlyMap.entries()).map(([month, total]) => ({ month, total }));
  const yearly = Array.from(yearlyMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, total]) => ({ year, total }));

  return {
    summary: { totalEarned, thisMonthEarned, thisYearEarned, submitted: pending },
    statusBreakdown: { submitted: pendingTotal, approved: approvedTotal, paid: paidTotal },
    monthly,
    yearly,
  };
}

export async function listAgentClaims(orgId: string, partyId: string, filters?: {
  status?: string; page?: number; limit?: number;
}) {
  const db = getDb();
  const where: Record<string, unknown> = { organizationId: orgId, agentPartyId: partyId };
  const VALID_STATUSES = ["draft", "submitted", "approved", "rejected", "paid"];
  if (filters?.status && VALID_STATUSES.includes(filters.status)) where.status = filters.status;

  const page = Math.max(filters?.page ?? 1, 1);
  const limit = Math.min(filters?.limit ?? 20, 100);

  const [data, total] = await Promise.all([
    db.commissionClaim.findMany({
      where,
      select: {
        id: true,
        claimNumber: true,
        status: true,
        totalNettPayout: true,
        claimType: true,
        submittedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.commissionClaim.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function findAgentClaim(orgId: string, partyId: string, claimId: string) {
  const db = getDb();
  return db.commissionClaim.findFirst({
    where: { id: claimId, organizationId: orgId, agentPartyId: partyId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          property: {
            select: { id: true, hasPaxDeduction: true, paxDeductionAmount: true },
          },
        },
      },
    },
  });
}

export async function findTierMapping(
  orgId: string,
  claimType: string,
  agentLevel: string,
  client?: PrismaLike,
) {
  const db = client ?? getDb();
  return db.agentTierMapping.findFirst({
    where: {
      organizationId: orgId,
      claimType,
      agentLevel,
      isActive: true,
    },
  });
}

// Single source of truth for claim-type → agent-tier percentage resolution.
// Direct claim types (`tenant_portion`, `listing_portion`) return the row
// percentage. The composite `tenant_listing_portion` is derived at lookup
// time as `tenant_portion.percentage + listing_portion.percentage` for the
// same agent level — used when one agent handles BOTH sides of a deal
// (direct deal with owner who lets the agent also source the tenant).
// Accepts an optional `client` so submit paths run inside a
// Prisma.TransactionClient snapshot; falls back to getDb() for non-tx
// callers (preview endpoint).
export type ResolveTierResult =
  | { ok: true; percentage: Decimal; source: "direct" | "derived" }
  | { ok: false; error: string };

export async function resolveTierPercentage(
  orgId: string,
  claimType: string,
  agentLevel: string,
  client?: PrismaLike,
): Promise<ResolveTierResult> {
  if (claimType === "tenant_listing_portion") {
    const [tenant, listing] = await Promise.all([
      findTierMapping(orgId, "tenant_portion", agentLevel, client),
      findTierMapping(orgId, "listing_portion", agentLevel, client),
    ]);
    if (!tenant) {
      return { ok: false, error: `Tenant Portion tier mapping is missing or inactive for ${agentLevel}.` };
    }
    if (!listing) {
      return { ok: false, error: `Listing Portion tier mapping is missing or inactive for ${agentLevel}.` };
    }
    return {
      ok: true,
      percentage: new Decimal(tenant.percentage).plus(new Decimal(listing.percentage)),
      source: "derived",
    };
  }

  const row = await findTierMapping(orgId, claimType, agentLevel, client);
  if (!row) {
    return { ok: false, error: `No active tier mapping for ${claimType} / ${agentLevel}.` };
  }
  return { ok: true, percentage: new Decimal(row.percentage), source: "direct" };
}

// Tx-aware variant of commission-number generation. Derives the next sequence
// number from MAX(claimNumber) for the year — gap-resilient (rollbacks leave
// gaps that COUNT-based numbering would collide with on the next insert).
//
// NB: Under concurrent submits the lookup can collide; Postgres Serializable
// will abort one of the txs with P2034 and the caller retries once. Collisions
// are further guarded by the unique index on (organizationId, claimNumber).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateClaimNumberTx(tx: any, orgId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CLM-${year}-`;
  const last = (await tx.commissionClaim.findFirst({
    where: {
      organizationId: orgId,
      claimNumber: { startsWith: prefix },
    },
    orderBy: { claimNumber: "desc" },
    select: { claimNumber: true },
  })) as { claimNumber: string } | null;
  const lastSeq = last ? parseInt(last.claimNumber.slice(prefix.length), 10) : 0;
  const nextSeq = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

export type SearchPropertiesUnit = {
  unitCode: string;
  rooms: Array<{ id: string; roomType: string; rentalRate: Decimal | null }>;
};

export type SearchPropertiesResult = {
  id: string;
  name: string;
  hasPaxDeduction: boolean;
  paxDeductionAmount: Decimal | null;
  units: SearchPropertiesUnit[];
};

export async function searchProperties(orgId: string, query?: string): Promise<SearchPropertiesResult[]> {
  const db = getDb();
  const where: Record<string, unknown> = { organizationId: orgId, status: "active" };
  if (query) where.name = { contains: query, mode: "insensitive" };

  const properties = await db.property.findMany({
    where,
    select: {
      id: true,
      name: true,
      hasPaxDeduction: true,
      paxDeductionAmount: true,
      apartments: {
        select: {
          unitCode: true,
          listings: {
            where: { listingStatus: { not: "archived" } },
            select: { id: true, listingType: true, rentalRate: true },
          },
        },
        orderBy: { unitCode: "asc" },
      },
    },
    take: 20,
    orderBy: { name: "asc" },
  });

  return properties.map((p) => ({
    id: p.id,
    name: p.name,
    hasPaxDeduction: p.hasPaxDeduction,
    paxDeductionAmount: p.paxDeductionAmount,
    // One entry per apartment (unitCode). The old flatMap produced one entry
    // per listing, causing partitioned apartments (Master/Medium/Small) to
    // appear multiple times in the agent-claim unit dropdown (Noelle WA
    // 22 May 10:16am, screenshot 58676db4).
    units: p.apartments.map((a) => ({
      unitCode: a.unitCode,
      rooms: a.listings.map((l) => ({
        id: l.id,
        roomType: l.listingType,
        rentalRate: l.rentalRate,
      })),
    })),
  }));
}

export async function listActiveRoomTypes(orgId: string) {
  const db = getDb();
  return db.roomType.findMany({
    where: { organizationId: orgId, isActive: true },
    select: { id: true, name: true, kind: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}
