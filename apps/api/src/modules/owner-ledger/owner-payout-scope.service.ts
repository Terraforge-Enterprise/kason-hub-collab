/**
 * resolveOwnerPayoutForScope — shared per-scope payout helper (Task 1).
 *
 * Returns the same `OwnerPayoutBreakdown` that `assembleYannieStatement` and
 * `getOwnerMonthsService` produce, but scoped to a SINGLE (owner, month,
 * optional apartment). Later tasks (receipt totals, units-summary) call this
 * so every surface converges on the ONE payout engine: `computeOwnerPayout`.
 *
 * PURE READ — does not modify any data. No schema or migration changes.
 */

import { getDb } from "@kason/db";
import { toCents } from "@kason/shared";
import {
  computeOwnerPayout,
  findOwnerLedgerRowsForMonth,
  fetchOwnerReceivablePayoutRows,
  type OwnerPayoutBreakdown,
} from "../owner-billing/owner-statement-sections";
import {
  findDepositsCollectedInMonth,
  depositWindowEndOfMonth,
} from "../owner-billing/owner-billing.repository";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

// Re-export for consumers who only import from this module.
export type { OwnerPayoutBreakdown };

/**
 * Fetch all inputs that `computeOwnerPayout` needs for the given
 * (owner, month, optional apartment) scope and return its breakdown.
 *
 * @param ctx      - Actor context (orgId + actor identity).
 * @param ownerPartyId - The owner's Party id.
 * @param month    - "YYYY-MM" string.  Only the year + month are used; the day
 *                   component is always normalised to the 1st of the month UTC.
 * @param apartmentId - When non-null, only ledger rows and listings belonging to
 *                      this apartment are included.  null ⇒ all apartments for
 *                      this owner.
 *
 * @returns `OwnerPayoutBreakdown` from `computeOwnerPayout`, or `null` when
 *          there are no active ledger rows for the given scope (empty month / no
 *          data yet).
 */
export async function resolveOwnerPayoutForScope(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string,
  apartmentId: string | null,
): Promise<OwnerPayoutBreakdown | null> {
  // 0. Validate month format before parsing — fail loudly on malformed input.
  if (!/^\d{4}-\d{2}$/.test(month))
    throw new Error(`resolveOwnerPayoutForScope: invalid month "${month}" (expected YYYY-MM)`);

  // 1. Parse month → first-of-month UTC Date (mirrors firstOfMonthUtc in receipt service).
  const [y, m] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(y!, m! - 1, 1));

  // 2. Fetch active ledger rows for this owner+month+scope (same query as assembleYannieStatement).
  const rows = await findOwnerLedgerRowsForMonth(ctx, ownerPartyId, monthStart, apartmentId);
  if (rows.length === 0) return null;

  const db = getDb();

  // 3. Fetch the owner's active ManagementFeeConfig rows — fetched ONCE for the
  //    owner (same query getOwnerMonthsService uses). computeOwnerPayout resolves
  //    per income-line property specificity (property-specific overrides the
  //    all-properties default, latest-updatedAt wins).
  const feeConfigRows = await db.managementFeeConfig.findMany({
    where: { organizationId: ctx.orgId, ownerPartyId, isActive: true },
    select: {
      propertyId: true,
      feeType: true,
      feeValue: true,
      capAmount: true,
      sstPercent: true,
      updatedAt: true,
    },
  });

  // 4. Resolve the owner's non-archived Listing ids scoped to this apartment (or all).
  //    Deposits are NOT ledger rows — they live on the Deposit table keyed by
  //    collection month (createdAt).  Mirror the exact listing filter
  //    getOwnerMonthsService uses (Prisma 7 null-safe negation for archived).
  const ownedListings = await db.listing.findMany({
    where: {
      organizationId: ctx.orgId,
      ownerPartyId,
      listingStatus: { not: "archived" },
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: { id: true },
  });
  const unitIds = ownedListings.map((l) => l.id);

  // 5. Aggregate deposits collected in this month window (same window as
  //    assembleYannieStatement + getOwnerMonthsService — depositWindowEndOfMonth
  //    gives the last-instant-of-month inclusive upper bound so last-day deposits
  //    are attributed to the correct month, M-C1).
  const monthEnd = depositWindowEndOfMonth(monthStart);
  const depositRows =
    unitIds.length > 0
      ? await findDepositsCollectedInMonth(ctx.orgId, unitIds, monthStart, monthEnd)
      : [];
  const depositCollectedC = depositRows.reduce(
    (acc, r) => acc + toCents(r.amount, "resolveOwnerPayoutForScope"),
    0,
  );

  // 6. Owner-borne IVOWN costs. NOT ledger rows (the durable XOR keeps a charge with
  //    a live IVOWN line out of Source 6), but unambiguously money the owner bears.
  //    Fetched through the SAME helper assembleYannieStatement uses — this surface
  //    briefly disagreed with the statement when the logic lived only over there.
  const receivableRows = await fetchOwnerReceivablePayoutRows(
    ctx.orgId,
    ownerPartyId,
    monthStart,
    apartmentId,
    rows,
  );

  // 7. Delegate to the ONE payout engine — pure, no DB access.
  return computeOwnerPayout({
    rows: [...rows, ...receivableRows] as typeof rows,
    feeConfigRows,
    depositCollectedC,
  });
}
