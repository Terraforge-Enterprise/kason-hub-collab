/**
 * Pure rent math — precedence pick + mid-month proration. Zero I/O, zero Prisma.
 *
 * Relocated here (Task 2, bills-grid batch loaders) from
 * `modules/billing/post-monthly-rent.ts`, which still owns the DB-touching
 * `resolveMonthlyRentAmount`/`postMonthlyRentForTenancy` and re-exports both
 * symbols below unchanged for its existing callers/tests — this is a pure move,
 * byte-identical logic, not a rewrite.
 *
 * WHY the move: `modules/bills-grid/service.ts` is a standalone module that must
 * NEVER import a money-writer module (enforced by
 * `bills-grid/__tests__/forbidden-writes.integration.test.ts`'s static guard,
 * which forbids any import specifier containing a `billing/` path segment —
 * a path-level check, so it cannot distinguish "this billing file's money-writing
 * export" from "this billing file's pure export"). `post-monthly-rent.ts` sits
 * under `billing/` and ALSO exports `postMonthlyRentForTenancy` (writes `Charge`
 * rows), so importing `pickBaseRent`/`computeProratedRent` from it — as the batch
 * loaders' own brief specifies verbatim — trips the guard even though neither
 * function touches a database. Moving the two pure functions to `lib/` (already
 * bills-grid's trusted source for `audit`/`storage` helpers) satisfies BOTH the
 * "reuse, do not re-implement precedence" requirement AND the guard, without
 * weakening the guard's protection for the rest of `billing/`.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Integer UTC-day index for a Date's CALENDAR day (time-of-day dropped). Two Dates on the
// same UTC calendar day always yield the same index, regardless of their time component —
// this is what makes day-count differencing immune to non-midnight `startDate`/`endDate`
// (Tenancy.startDate/endDate are bare `DateTime`, not `@db.Date`, and the Excel data
// importer writes a non-midnight startDate; see review R9 findings 1+2).
function dayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
}

/**
 * Pro-rate the month's rent for a mid-month tenancy start AND/OR move-out (R9).
 * Clamps the tenancy's occupancy window [startDate, endDate] to the queried
 * [monthStart, monthEnd] and bills only the occupied-day overlap:
 *   amount = round2(rent × occupiedDays / daysInMonth), occupiedDays inclusive of
 *   both window endpoints, clamped to 0 (never negative — e.g. bad data where
 *   endDate < startDate, or a month entirely outside the occupancy window).
 * `endDate: null` means still-open (no move-out yet) — legacy month-end behavior.
 * A month fully covered by the tenancy (occupiedDays >= daysInMonth) returns the
 * flat `rent` (avoids float drift from an exact daysInMonth/daysInMonth division).
 * (Spec worked example: RM980 × 16/30 = RM522.67 for a June-15 start.)
 * All comparisons are UTC. Occupied days are counted by UTC CALENDAR day (via `dayIndex`),
 * not raw millisecond subtraction — `startDate`/`endDate` are bare `DateTime` columns (not
 * `@db.Date`) and are not guaranteed to be UTC-midnight (e.g. the Excel data importer writes
 * a non-midnight `startDate`), so the count must be immune to their time-of-day component.
 */
export function computeProratedRent(rent: number, startDate: Date, endDate: Date | null, month: Date): number {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m, daysInMonth));
  const winStart = startDate > monthStart ? startDate : monthStart;
  const winEnd = endDate && endDate < monthEnd ? endDate : monthEnd;
  // Day-index (not raw ms) difference — calendar-based and time-of-day-immune.
  const occupiedDays = Math.max(0, dayIndex(winEnd) - dayIndex(winStart) + 1);
  if (occupiedDays >= daysInMonth) return round2(rent);
  return round2((rent * occupiedDays) / daysInMonth);
}

/** Rent precedence, single source: RecurringCharge(rent) → reservation → tenancy. Pure. */
export function pickBaseRent(
  recurringChargeAmount: number | null,
  reservationAgreedRent: number | null,
  tenancyMonthlyRent: number,
): number {
  if (recurringChargeAmount != null) return recurringChargeAmount;
  if (reservationAgreedRent != null) return reservationAgreedRent;
  return tenancyMonthlyRent;
}
