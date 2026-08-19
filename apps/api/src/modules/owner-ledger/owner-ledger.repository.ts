import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { OwnerLedgerLine } from "@kason/shared";
import { toCents, centsToString, computeOwnerRunningBalance, summarizeOwnerPeriod } from "@kason/shared";
import { findDepositsCollectedInMonth, depositWindowEndOfMonth } from "../owner-billing/owner-billing.repository";
import {
  type DbOwnerLedgerEntry,
  type OwnerLedgerListFilters,
  type OwnerLedgerPagination,
  type OwnerLedgerPeriodArgs,
  rowToLedgerLine,
} from "./owner-ledger.types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM string to the first-of-month UTC Date Prisma expects for a
 * @db.Date column.
 */
function firstOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1));
}

/**
 * Return the last moment of a YYYY-MM month: the first day of the NEXT month
 * (exclusive upper bound for `lt`). We use an inclusive `lte` with end-of-month
 * day instead to keep the query readable — Postgres @db.Date stores only the
 * date part, so lte("2026-06-30") == lt("2026-07-01").
 */
function lastOfMonth(ym: string): Date {
  const [year, month] = ym.split("-").map(Number);
  // Day 0 of next month = last day of current month in UTC.
  return new Date(Date.UTC(year!, month!, 0));
}

/**
 * Signed 2dp money string → integer cents. The shared `toCents` primitive is
 * deliberately non-negative-only; ledger running balances (brought/carried
 * forward, period net) may be negative ("KAEN fronted"), so peel the sign here.
 *
 * Exported so the owner-statement freeze service (Task 4) converts the exact
 * SAME balance strings this module produces into cents identically — one
 * conversion primitive, no float drift, no per-caller reimplementation.
 */
export function signedToCents(s: string, label: string): number {
  const neg = s.startsWith("-");
  return (neg ? -1 : 1) * toCents(neg ? s.slice(1) : s, label);
}

// ─── Create ───────────────────────────────────────────────────────────────────

/**
 * Insert one OwnerLedgerEntry. Runs inside the caller's transaction so the
 * audit row lands atomically alongside it. The caller (service) stamps
 * `includeInPayout`, `createdById`, and `updatedById` in `data` before calling.
 */
export async function createEntry(
  tx: Prisma.TransactionClient,
  data: Prisma.OwnerLedgerEntryUncheckedCreateInput,
): Promise<DbOwnerLedgerEntry> {
  return tx.ownerLedgerEntry.create({ data });
}

// ─── Read (single) ────────────────────────────────────────────────────────────

/**
 * Org-scoped single-row read. Returns the row or null.
 * A cross-org id resolves to null → the service maps that to 404.
 */
export async function getEntry(
  orgId: string,
  id: string,
): Promise<DbOwnerLedgerEntry | null> {
  const db = getDb();
  return db.ownerLedgerEntry.findFirst({
    where: { id, organizationId: orgId },
  });
}

// ─── Read (list) ─────────────────────────────────────────────────────────────

/**
 * Org-scoped paginated list with optional filters. All status values (including
 * void) are returned — the admin list shows a status column. `hasAttachment` maps
 * to a non-empty / empty `attachmentKeys` array.
 */
export async function listEntries(
  orgId: string,
  filters: OwnerLedgerListFilters,
  page: OwnerLedgerPagination,
): Promise<{ rows: DbOwnerLedgerEntry[]; total: number }> {
  const db = getDb();

  const where: Prisma.OwnerLedgerEntryWhereInput = {
    organizationId: orgId,
    ...(filters.ownerPartyId ? { ownerPartyId: filters.ownerPartyId } : {}),
    ...(filters.propertyId ? { propertyId: filters.propertyId } : {}),
    ...(filters.apartmentId ? { apartmentId: filters.apartmentId } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.paidBy ? { paidBy: filters.paidBy } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.taxCategory ? { taxCategory: filters.taxCategory } : {}),
  };

  // Exact month takes precedence over fromMonth/toMonth range.
  if (filters.month) {
    where.statementMonth = firstOfMonth(filters.month);
  } else {
    const rangeFilter: Prisma.DateTimeFilter = {};
    if (filters.fromMonth) rangeFilter.gte = firstOfMonth(filters.fromMonth);
    if (filters.toMonth) rangeFilter.lte = lastOfMonth(filters.toMonth);
    if (Object.keys(rangeFilter).length > 0) where.statementMonth = rangeFilter;
  }

  // hasAttachment: non-empty array → { not: { equals: [] } }; empty → { equals: [] }
  if (filters.hasAttachment === true) {
    where.attachmentKeys = { isEmpty: false };
  } else if (filters.hasAttachment === false) {
    where.attachmentKeys = { isEmpty: true };
  }

  const [rows, total] = await db.$transaction([
    db.ownerLedgerEntry.findMany({
      where,
      orderBy: [{ statementMonth: "desc" }, { transactionDate: "desc" }, { createdAt: "desc" }],
      take: page.limit,
      skip: page.offset,
    }),
    db.ownerLedgerEntry.count({ where }),
  ]);

  return { rows, total };
}

// ─── Void ────────────────────────────────────────────────────────────────────

/**
 * Guarded void: sets `status:"void"` on a single row using an
 * optimistic-concurrency WHERE on org + expected updatedAt. Returns `.count` —
 * caller maps `0` → 409. Accepts the expectedUpdatedAt concurrency token to
 * prevent double-void races.
 */
export async function voidEntry(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
  expectedUpdatedAt: string,
  actorUserId: string,
): Promise<number> {
  const result = await tx.ownerLedgerEntry.updateMany({
    where: { id, organizationId: orgId, updatedAt: new Date(expectedUpdatedAt) },
    data: { status: "void", updatedById: actorUserId },
  });
  return result.count;
}

// ─── Period read for payout calc ─────────────────────────────────────────────

/**
 * Active rows in a [fromMonth, toMonth] window mapped to the `OwnerLedgerLine`
 * shape consumed by `summarizeOwnerPeriod` / `summarizeTax`. Void rows are
 * excluded. org-scoped; optional owner / property narrowing.
 *
 * Decimal columns (amount, sstAmount) are serialised via `.toString()` inside
 * `rowToLedgerLine` — the pure calc receives only plain strings.
 */
export async function listForPeriod(
  orgId: string,
  args: OwnerLedgerPeriodArgs,
): Promise<OwnerLedgerLine[]> {
  const db = getDb();

  // Build optional date range filter. Both omitted = all-time (no statementMonth filter).
  const rangeFilter: Prisma.DateTimeFilter = {};
  if (args.fromMonth) rangeFilter.gte = firstOfMonth(args.fromMonth);
  if (args.toMonth) rangeFilter.lte = lastOfMonth(args.toMonth);

  const where: Prisma.OwnerLedgerEntryWhereInput = {
    organizationId: orgId,
    status: "active",
    ...(Object.keys(rangeFilter).length > 0 ? { statementMonth: rangeFilter } : {}),
  };

  if (args.ownerPartyId) where.ownerPartyId = args.ownerPartyId;
  if (args.propertyId) where.propertyId = args.propertyId;

  const rows = await db.ownerLedgerEntry.findMany({
    where,
    orderBy: [{ statementMonth: "asc" }, { transactionDate: "asc" }],
  });

  return rows.map(rowToLedgerLine);
}

// ─── Owner-tree resolution ────────────────────────────────────────────────────

export type OwnerTree = {
  properties: Array<{
    id: string;
    name: string;
    units: Array<{
      apartmentId: string;
      unitCode: string;
      listingMode: "WHOLE" | "PARTITIONED";
      rooms: Array<{
        listingId: string;
        listingType: string;
        occupancyStatus: string;
        tenancy: { tenancyId: string; tenantDisplayName: string } | null;
      }>;
    }>;
  }>;
};

/**
 * Resolve the full property → apartment → listing tree for an owner party, keyed
 * per-unit by Listing.ownerPartyId (owner money is attributed per-unit, NOT
 * per-property via LandlordTenancy). Archived listings are excluded. Vacant rooms
 * have `tenancy: null`; occupied rooms carry the active tenancy id and the tenant's
 * display name.
 *
 * The flat owned-listing query is grouped back into the property → apartment →
 * room tree in JS, preserving unitCode ordering. Only apartments/properties that
 * actually contain ≥1 owned non-archived listing appear (a partition where the
 * owner owns only some rooms surfaces ONLY those rooms — the per-unit fix).
 */
export async function resolveOwnerTree(
  orgId: string,
  ownerPartyId: string,
): Promise<OwnerTree> {
  const db = getDb();
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId,
      organizationId: orgId,
      listingStatus: { not: "archived" },
    },
    select: {
      id: true,
      listingType: true,
      occupancyStatus: true,
      apartmentId: true,
      apartment: {
        select: {
          unitCode: true,
          listingMode: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
      tenancies: {
        where: { status: "active" },
        select: {
          id: true,
          tenantParty: { select: { displayName: true } },
        },
        take: 1,
      },
    },
    orderBy: { apartment: { unitCode: "asc" } },
  });

  type ApartmentNode = OwnerTree["properties"][number]["units"][number];
  type PropertyNode = OwnerTree["properties"][number];

  // Group: propertyId → property node; apartmentId → apartment node (within it).
  // Insertion order follows the unitCode-ordered listing scan.
  const propertyMap = new Map<string, PropertyNode>();
  const apartmentMap = new Map<string, ApartmentNode>();
  for (const listing of ownedListings) {
    const propertyId = listing.apartment.propertyId;
    let property = propertyMap.get(propertyId);
    if (!property) {
      property = { id: propertyId, name: listing.apartment.property.name, units: [] };
      propertyMap.set(propertyId, property);
    }
    let apartment = apartmentMap.get(listing.apartmentId);
    if (!apartment) {
      apartment = {
        apartmentId: listing.apartmentId,
        unitCode: listing.apartment.unitCode,
        listingMode: listing.apartment.listingMode as "WHOLE" | "PARTITIONED",
        rooms: [],
      };
      apartmentMap.set(listing.apartmentId, apartment);
      property.units.push(apartment);
    }
    const activeTenancy = listing.tenancies[0] ?? null;
    apartment.rooms.push({
      listingId: listing.id,
      listingType: listing.listingType,
      occupancyStatus: listing.occupancyStatus,
      tenancy: activeTenancy
        ? {
            tenancyId: activeTenancy.id,
            tenantDisplayName: activeTenancy.tenantParty.displayName,
          }
        : null,
    });
  }
  return { properties: [...propertyMap.values()] };
}

// ─── Owners summary aggregate ─────────────────────────────────────────────────

export type OwnersSummaryRow = {
  ownerPartyId: string;
  ownerName: string;
  unitCount: number;
  /** Distinct unit codes from this owner's owned non-archived listings' apartments. */
  unitCodes: string[];
  grossRental: string;
  totalExpenses: string;
  netPayoutToOwner: string;
  pendingCount: number;
  lastEntryMonth: string | null;
  /**
   * Per-apartment financial sub-rows — ADDITIVE (Task 7). One entry per distinct
   * non-null `apartmentId` that appears in this owner's active entries, sorted by
   * unitCode. Each uses the IDENTICAL gross/expense/payout formula as the owner
   * row above. Property-level / owner-combined entries (null apartmentId) are
   * EXCLUDED here but STILL counted in the owner-row scalars — so the unit nets
   * reconcile to the owner net minus any null-apartment remainder. Forward-dep
   * for the admin per-unit drill-down (web Task 8/9).
   */
  units: Array<{
    apartmentId: string;
    unitCode: string;
    grossRental: string;
    totalExpenses: string;
    netPayoutToOwner: string;
  }>;
};

export type OwnersSummary = { owners: OwnersSummaryRow[] };

/**
 * Aggregate active OwnerLedgerEntry rows grouped by ownerPartyId. When
 * fromMonth/toMonth are omitted the bound is open (all-time). Per owner:
 * gross (Σ income amount+sstAmount), expenses (Σ expense amount+sstAmount),
 * netPayoutToOwner (Σ income − Σ expense where includeInPayout),
 * pendingCount (paymentStatus="pending"), lastEntryMonth (max statementMonth
 * as YYYY-MM), unitCodes (distinct unitCode values from the owner's owned
 * non-archived listings' apartments, keyed by Listing.ownerPartyId).
 * Joins Party.displayName for ownerName. Returns only owners with at least one
 * active entry, sorted by ownerName ascending.
 */
export async function resolveOwnersSummary(
  orgId: string,
  fromMonth?: string,
  toMonth?: string,
): Promise<OwnersSummary> {
  const db = getDb();

  // 1. Fetch all active entries in range (open-bounded if months omitted).
  const rangeFilter: Prisma.DateTimeFilter = {};
  if (fromMonth) rangeFilter.gte = firstOfMonth(fromMonth);
  if (toMonth) rangeFilter.lte = lastOfMonth(toMonth);

  const entries = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      status: "active",
      ...(Object.keys(rangeFilter).length > 0 ? { statementMonth: rangeFilter } : {}),
    },
    select: {
      ownerPartyId: true,
      apartmentId: true, // Task 7: per-unit sub-rows. Extra field — the owner loop below does NOT read it, so its output is unchanged.
      direction: true,
      amount: true,
      sstAmount: true,
      includeInPayout: true,
      paymentStatus: true,
      statementMonth: true,
    },
  });

  if (entries.length === 0) return { owners: [] };

  // 2. Group by ownerPartyId in JS.
  const ownerIds = [...new Set(entries.map((e) => e.ownerPartyId))];

  // 3. Batch-fetch Party displayNames.
  const parties = await db.party.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, displayName: true },
  });
  const partyNameMap = new Map(parties.map((p) => [p.id, p.displayName]));

  // 4. Batch-fetch distinct apartments (id + unitCode) per owner from the owner's
  // OWNED non-archived listings (keyed per-unit by Listing.ownerPartyId; owner
  // money is attributed per-unit, NOT per-property via LandlordTenancy). Multiple
  // listings can share an apartment → the Sets dedupe to distinct apartments.
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId: { in: ownerIds },
      organizationId: orgId,
      listingStatus: { not: "archived" },
    },
    select: {
      ownerPartyId: true,
      apartmentId: true,
      apartment: { select: { unitCode: true } },
    },
  });

  // Build ownerPartyId → distinct apartment id set AND unitCode set.
  const ownerApartmentIds = new Map<string, Set<string>>();
  const ownerUnitCodes = new Map<string, Set<string>>();
  for (const listing of ownedListings) {
    // ownerPartyId is in the WHERE → never null here, but narrow for the type.
    const owner = listing.ownerPartyId;
    if (!owner) continue;
    const aptSet = ownerApartmentIds.get(owner) ?? new Set<string>();
    const codeSet = ownerUnitCodes.get(owner) ?? new Set<string>();
    aptSet.add(listing.apartmentId);
    codeSet.add(listing.apartment.unitCode);
    ownerApartmentIds.set(owner, aptSet);
    ownerUnitCodes.set(owner, codeSet);
  }

  // 5. Aggregate per owner.
  const grouped = new Map<
    string,
    {
      grossC: number;
      expenseC: number;
      payoutExpenseC: number;
      pendingCount: number;
      lastMonthTs: number; // Unix ms for max comparison
    }
  >();

  for (const e of entries) {
    const g = grouped.get(e.ownerPartyId) ?? {
      grossC: 0,
      expenseC: 0,
      payoutExpenseC: 0,
      pendingCount: 0,
      lastMonthTs: 0,
    };

    // amount + sstAmount using integer cents. Guard against negative/malformed DB
    // values — a single bad row should not 500 the entire owners-summary response.
    let amtC = 0;
    let sstC = 0;
    try {
      const amtStr = e.amount.toString();
      amtC = Number(amtStr) < 0 ? 0 : toCents(amtStr, "resolveOwnersSummary");
    } catch {
      // skip malformed amount
    }
    try {
      if (e.sstAmount != null) {
        const sstStr = e.sstAmount.toString();
        sstC = Number(sstStr) < 0 ? 0 : toCents(sstStr, "resolveOwnersSummary");
      }
    } catch {
      // skip malformed sstAmount
    }
    const totalC = amtC + sstC;

    if (e.direction === "income") {
      g.grossC += totalC;
    } else if (e.direction === "expense") {
      g.expenseC += totalC;
      if (e.includeInPayout) g.payoutExpenseC += totalC;
    }

    if (e.paymentStatus === "pending") g.pendingCount += 1;

    const ts = e.statementMonth.getTime();
    if (ts > g.lastMonthTs) g.lastMonthTs = ts;

    grouped.set(e.ownerPartyId, g);
  }

  // 5b. SECOND PASS (additive, Task 7) — per-apartment sub-rows. Groups the SAME
  // `entries` by (ownerPartyId, apartmentId), SKIPPING null-apartment rows
  // (property-level / owner-combined-only). Uses the IDENTICAL income/expense/SST/
  // toCents formula as the owner loop above; that loop is intentionally left
  // UNTOUCHED so its scalar output stays byte-frozen. apartmentId → unitCode
  // resolves from the already-fetched `ownedListings` (no extra query).
  const apartmentUnitCode = new Map<string, string>();
  for (const listing of ownedListings) {
    apartmentUnitCode.set(listing.apartmentId, listing.apartment.unitCode);
  }

  type UnitAccum = { grossC: number; expenseC: number; payoutExpenseC: number };
  // ownerPartyId → (apartmentId → accumulator)
  const ownerUnitAccum = new Map<string, Map<string, UnitAccum>>();
  for (const e of entries) {
    if (e.apartmentId == null) continue; // property-level / owner-combined-only

    // Identical guarded amount+sst cents as the owner loop — a single bad row must
    // not 500 the response.
    let amtC = 0;
    let sstC = 0;
    try {
      const amtStr = e.amount.toString();
      amtC = Number(amtStr) < 0 ? 0 : toCents(amtStr, "resolveOwnersSummary");
    } catch {
      // skip malformed amount
    }
    try {
      if (e.sstAmount != null) {
        const sstStr = e.sstAmount.toString();
        sstC = Number(sstStr) < 0 ? 0 : toCents(sstStr, "resolveOwnersSummary");
      }
    } catch {
      // skip malformed sstAmount
    }
    const totalC = amtC + sstC;

    let byApt = ownerUnitAccum.get(e.ownerPartyId);
    if (!byApt) {
      byApt = new Map<string, UnitAccum>();
      ownerUnitAccum.set(e.ownerPartyId, byApt);
    }
    const u = byApt.get(e.apartmentId) ?? { grossC: 0, expenseC: 0, payoutExpenseC: 0 };
    if (e.direction === "income") {
      u.grossC += totalC;
    } else if (e.direction === "expense") {
      u.expenseC += totalC;
      if (e.includeInPayout) u.payoutExpenseC += totalC;
    }
    byApt.set(e.apartmentId, u);
  }

  // 6. Build output rows.
  const rows: OwnersSummaryRow[] = [];
  for (const [ownerPartyId, g] of grouped) {
    const lastEntryMonth =
      g.lastMonthTs > 0
        ? (() => {
            const d = new Date(g.lastMonthTs);
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, "0");
            return `${y}-${m}`;
          })()
        : null;

    const unitCodeSet = ownerUnitCodes.get(ownerPartyId);
    const unitCodes = unitCodeSet ? [...unitCodeSet].sort() : [];

    // Per-apartment sub-rows (Task 7) — same formula as the owner scalars above.
    // unitCode falls back to the apartmentId if the apartment's listing is no
    // longer owned/non-archived (so the row is never dropped or mislabelled).
    const unitAccum = ownerUnitAccum.get(ownerPartyId);
    const units = unitAccum
      ? [...unitAccum.entries()]
          .map(([apartmentId, u]) => ({
            apartmentId,
            unitCode: apartmentUnitCode.get(apartmentId) ?? apartmentId,
            grossRental: centsToString(u.grossC),
            totalExpenses: centsToString(u.expenseC),
            netPayoutToOwner: centsToString(u.grossC - u.payoutExpenseC),
          }))
          .sort((a, b) => a.unitCode.localeCompare(b.unitCode))
      : [];

    rows.push({
      ownerPartyId,
      ownerName: partyNameMap.get(ownerPartyId) ?? ownerPartyId,
      unitCount: ownerApartmentIds.get(ownerPartyId)?.size ?? 0,
      unitCodes,
      grossRental: centsToString(g.grossC),
      totalExpenses: centsToString(g.expenseC),
      netPayoutToOwner: centsToString(g.grossC - g.payoutExpenseC),
      pendingCount: g.pendingCount,
      lastEntryMonth,
      units,
    });
  }

  // Sort by ownerName ascending.
  rows.sort((a, b) => a.ownerName.localeCompare(b.ownerName));

  return { owners: rows };
}

// ─── Owner running balance ────────────────────────────────────────────────────

export type OwnerBalanceResult = {
  broughtForward: string;
  periodGross: string;
  periodExpenses: string;
  periodPayouts: string;
  netThisPeriod: string;
  /**
   * Deposit collected in [fromMonth, toMonth] — a NON-INCOME cash-in folded into
   * netThisPeriod and the carry-forward (Yannie "Add: Deposit Collected This
   * Month"). NOT rental income (no mgmt fee, not taxable); the owner receives it.
   */
  depositCollected: string;
  carriedForward: string;
};

/**
 * Compute the owner's running balance for a period — DEPOSIT-AWARE (G6).
 *
 * Ledger side:
 * - broughtForwardLedger = computeOwnerRunningBalance(active lines with statementMonth < firstOfMonth(fromMonth))
 *   (0 if no fromMonth)
 * - period figures from summarizeOwnerPeriod(active lines in [fromMonth, toMonth])
 * - carriedForwardLedger = computeOwnerRunningBalance(active lines with statementMonth <= toMonth)
 *   (open upper bound if no toMonth = all-time)
 *
 * Deposit side (non-income cash-in; deposits are NOT ledger rows):
 * - Threaded via findDepositsCollectedInMonth over the owner's non-archived units,
 *   keyed by the deposit's collection month (createdAt), using the SAME
 *   [first-of-month, end-of-day-inclusive last-of-month] window (shared
 *   depositWindowEndOfMonth) as assembleYannieStatement so the carry-forward
 *   reconciles with the statement's deposit-inclusive Total Payout.
 * - broughtForward    = broughtForwardLedger + deposits collected BEFORE fromMonth
 * - netThisPeriod     = period netPayout      + deposits collected in [fromMonth, toMonth]
 * - carriedForward    = carriedForwardLedger + broughtForwardDeposit + periodDeposit
 *   (DERIVED from brought + period rather than an independent "deposits ≤ toMonth"
 *   query, so the close-out identity holds EXACTLY in integer cents:
 *      broughtForward + netThisPeriod − periodPayouts = carriedForward.)
 *
 * SEAM: a future deposit-REFUND debit (tenant leaves) subtracts on the deposit
 * side here; sub-project C is collection-side only.
 *
 * All values are 2dp strings. Org+owner scoped, status="active".
 *
 * SCOPE (`apartmentId`, optional, backward-compatible): omit/undefined = the
 * owner-WIDE balance (every unit + every owned listing's deposits — the original
 * behavior). Pass an apartmentId to scope BOTH the ledger lines AND the deposit
 * set to that single unit (its listings), so a per-unit owner statement (Task 4
 * freeze) gets that unit's opening/closing/net rather than the owner's total.
 * The carry-forward identity holds within whichever scope is chosen.
 */
export async function resolveOwnerBalance(
  orgId: string,
  ownerPartyId: string,
  fromMonth?: string,
  toMonth?: string,
  apartmentId?: string | null,
): Promise<OwnerBalanceResult> {
  const db = getDb();

  // Helper to fetch active lines for a given date range
  async function fetchLines(gte?: Date, lt?: Date, lte?: Date): Promise<OwnerLedgerLine[]> {
    const rangeFilter: Prisma.DateTimeFilter = {};
    if (gte) rangeFilter.gte = gte;
    if (lt) rangeFilter.lt = lt;
    if (lte) rangeFilter.lte = lte;

    const where: Prisma.OwnerLedgerEntryWhereInput = {
      organizationId: orgId,
      ownerPartyId,
      status: "active",
      // Per-unit scope (Task 4): restrict to this apartment's rows when set.
      ...(apartmentId ? { apartmentId } : {}),
      ...(Object.keys(rangeFilter).length > 0 ? { statementMonth: rangeFilter } : {}),
    };

    const rows = await db.ownerLedgerEntry.findMany({
      where,
      orderBy: [{ statementMonth: "asc" }, { transactionDate: "asc" }],
    });

    return rows.map(rowToLedgerLine);
  }

  // broughtForward: all active lines with statementMonth strictly < firstOfMonth(fromMonth)
  const broughtForwardLines = fromMonth
    ? await fetchLines(undefined, firstOfMonth(fromMonth), undefined)
    : [];
  const broughtForward = fromMonth ? computeOwnerRunningBalance(broughtForwardLines) : "0.00";

  // period lines: [fromMonth, toMonth]
  const periodGte = fromMonth ? firstOfMonth(fromMonth) : undefined;
  const periodLte = toMonth ? lastOfMonth(toMonth) : undefined;
  const periodLines = await fetchLines(periodGte, undefined, periodLte);
  const periodSummary = summarizeOwnerPeriod(periodLines);

  // carriedForward: all active lines with statementMonth <= toMonth (or all-time)
  const carriedForwardLines = toMonth
    ? await fetchLines(undefined, undefined, lastOfMonth(toMonth))
    : await fetchLines(); // no bounds = all-time
  const carriedForward = computeOwnerRunningBalance(carriedForwardLines);

  // ── G6: deposit-collected as a non-income cash-in ──────────────────────────
  // Deposits are not ledger rows; sum them over the owner's non-archived units
  // (same listing set assembleYannieStatement uses, incl. carpark), bucketed by
  // collection month (createdAt). The brought window ends at the last instant
  // BEFORE fromMonth (firstOfMonth(fromMonth) − 1 ms) and the period window's
  // upper bound is the end-of-day-INCLUSIVE last instant of toMonth (shared
  // depositWindowEndOfMonth) — so a deposit collected any time on the last
  // calendar day counts in the period (M-C1), the two windows tile with NO
  // gap/overlap, and carriedForward(N) === broughtForward(N+1) (the period upper
  // bound for month N is byte-identical to the brought bound for month N+1).
  const ownedListings = await db.listing.findMany({
    where: {
      ownerPartyId,
      organizationId: orgId,
      listingStatus: { not: "archived" },
      // Per-unit scope (Task 4): only THIS apartment's listings contribute
      // deposits when apartmentId is set, so the deposit cash-in matches the
      // unit-scoped ledger lines above.
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: { id: true },
  });
  const unitIds = ownedListings.map((l) => l.id);

  const EPOCH = new Date(0);
  const FAR_FUTURE = new Date(8640000000000000); // max valid JS Date
  const sumDepositsCents = async (gte: Date, lte: Date): Promise<number> => {
    const rows = await findDepositsCollectedInMonth(orgId, unitIds, gte, lte);
    return rows.reduce((acc, r) => acc + toCents(r.amount, "resolveOwnerBalance"), 0);
  };

  const broughtForwardDepositC = fromMonth
    ? await sumDepositsCents(EPOCH, new Date(firstOfMonth(fromMonth).getTime() - 1))
    : 0;
  const periodDepositC = await sumDepositsCents(
    fromMonth ? firstOfMonth(fromMonth) : EPOCH,
    // End-of-day-INCLUSIVE last instant of toMonth (NOT lastOfMonth, which is
    // midnight of the last day and would drop a last-day deposit) — M-C1.
    toMonth ? depositWindowEndOfMonth(firstOfMonth(toMonth)) : FAR_FUTURE,
  );

  const broughtForwardC = signedToCents(broughtForward, "resolveOwnerBalance") + broughtForwardDepositC;
  const netThisPeriodC =
    signedToCents(periodSummary.netPayoutToOwner, "resolveOwnerBalance") + periodDepositC;
  // DERIVE carried = carriedLedger + brought-deposit + period-deposit → identity-safe.
  const carriedForwardC =
    signedToCents(carriedForward, "resolveOwnerBalance") + broughtForwardDepositC + periodDepositC;

  return {
    broughtForward: centsToString(broughtForwardC),
    periodGross: periodSummary.grossRental,
    periodExpenses: periodSummary.totalExpenses,
    periodPayouts: periodSummary.payoutsTotal,
    netThisPeriod: centsToString(netThisPeriodC),
    depositCollected: centsToString(periodDepositC),
    carriedForward: centsToString(carriedForwardC),
  };
}
