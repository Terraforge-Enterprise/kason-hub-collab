import { getDb, Prisma, type OwnerStatementPeriod } from "@kason/db";

/**
 * OwnerStatementPeriod repository — the persisted, frozen owner-statement period
 * snapshot (balances + monotonic-write guard). Consumed by the freeze service
 * (Task 4); no other consumers yet.
 *
 * Idempotency contract (see Task 2's review): the composite unique
 * (org, ownerPartyId, apartmentId, periodMonth) is NULLs-DISTINCT in Postgres,
 * so for a combined-scope row (apartmentId = NULL) it does NOT prevent two
 * statements for one owner/month. The ONLY guard is the (organizationId,
 * idempotencyKey) unique — therefore upsertFrozenPeriod finds/dedupes on
 * (orgId, idempotencyKey), never on the composite.
 */
export type PeriodScope = { ownerPartyId: string; apartmentId: string | null; periodMonth: Date };

/**
 * Look a period up by its natural scope (org, owner, apartment-or-combined,
 * month). apartmentId === null matches the combined-scope row (SQL IS NULL).
 */
export async function findPeriod(orgId: string, s: PeriodScope): Promise<OwnerStatementPeriod | null> {
  // findFirst (not findUnique) but assumes at most ONE row per scope — guaranteed
  // by the (org, idempotencyKey) unique + deterministic keys. apartmentId ?? null
  // maps an accidental undefined (untyped caller) to IS NULL rather than dropping
  // the filter and over-matching every unit.
  return getDb().ownerStatementPeriod.findFirst({
    where: {
      organizationId: orgId,
      ownerPartyId: s.ownerPartyId,
      apartmentId: s.apartmentId ?? null,
      periodMonth: s.periodMonth,
    },
  });
}

/**
 * Idempotent + monotonic upsert of a frozen period.
 *
 *  - Dedupe key: (organizationId, idempotencyKey). A second call with the same
 *    key updates (or no-ops) the existing row — it never inserts a duplicate.
 *  - Monotonic guard: when a row already exists AND its stored sourceMaxUpdatedAt
 *    is >= the incoming one, the incoming write is a stale recompute and is
 *    rejected (the existing, newer snapshot is returned unchanged).
 *
 * Money-safety notes:
 *  - sourceMaxUpdatedAt is coerced to a real Date once (Prisma types the field
 *    as `Date | string`; comparing `Date >= isoString` would ToNumber-coerce the
 *    string to NaN, silently disabling the guard and letting a stale write win).
 *  - The overwrite is ATOMICALLY guarded: the update is a `updateMany` whose
 *    WHERE re-asserts `sourceMaxUpdatedAt < incoming`, so under two concurrent
 *    same-key recomputes a staler writer committing last matches 0 rows instead
 *    of clobbering a fresher snapshot (the find-then-update serial fast-path
 *    alone is a lost-update race). The create path stays protected by the
 *    (organizationId, idempotencyKey) unique — a concurrent 2nd create throws
 *    P2002, a retryable error the caller must NOT swallow.
 */
export async function upsertFrozenPeriod(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: Omit<Prisma.OwnerStatementPeriodUncheckedCreateInput, "organizationId">,
): Promise<OwnerStatementPeriod> {
  const incoming = new Date(data.sourceMaxUpdatedAt); // coerce once — never compare Date >= string
  const existing = await tx.ownerStatementPeriod.findFirst({
    where: { organizationId: orgId, idempotencyKey: data.idempotencyKey },
  });
  if (existing) {
    if (existing.sourceMaxUpdatedAt >= incoming) {
      return existing; // stale (or equal) recompute — keep the newer snapshot
    }
    // Atomic monotonic guard: only overwrite if the row is STILL older at write
    // time (guards the find-then-update lost-update race). A stale concurrent
    // writer that lost the read/write window matches 0 rows here and no-ops.
    await tx.ownerStatementPeriod.updateMany({
      where: { id: existing.id, sourceMaxUpdatedAt: { lt: incoming } },
      data: { ...data, sourceMaxUpdatedAt: incoming },
    });
    return tx.ownerStatementPeriod.findFirstOrThrow({ where: { id: existing.id } });
  }
  return tx.ownerStatementPeriod.create({
    data: { ...data, organizationId: orgId, sourceMaxUpdatedAt: incoming },
  });
}

/**
 * List an owner's FROZEN periods for a scope (combined when apartmentId === null,
 * else per-unit), optionally constrained to a single calendar year, newest month
 * first.
 */
export async function listFrozenPeriodsForOwner(
  orgId: string,
  ownerPartyId: string,
  apartmentId: string | null,
  year?: string,
): Promise<OwnerStatementPeriod[]> {
  const yearFilter =
    year && /^\d{4}$/.test(year)
      ? { gte: new Date(Date.UTC(+year, 0, 1)), lte: new Date(Date.UTC(+year, 11, 31)) }
      : undefined;
  return getDb().ownerStatementPeriod.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      apartmentId: apartmentId ?? null, // undefined → IS NULL (combined), never omit-and-over-match
      status: "frozen",
      ...(yearFilter ? { periodMonth: yearFilter } : {}),
    },
    orderBy: { periodMonth: "desc" },
  });
}
