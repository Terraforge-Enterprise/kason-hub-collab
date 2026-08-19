/**
 * Period-aware tenancy selection (single source of truth).
 *
 * A month must be priced against the tenancies that OCCUPIED it, not against
 * whoever happens to be `status: "active"` today. Selecting by current status
 * prices a period against a tenancy that may not overlap it at all — e.g. a
 * replacement tenancy starting 2026-08-01 evaluated for July yields zero
 * occupied days, so the July rent resolves to RM0.00 while July's real
 * occupant (now `ended`) is never billed at all.
 *
 * Pure: zero I/O, zero Prisma. Day comparisons go through `dayIndex` (UTC
 * calendar day, time-of-day dropped) for the same reason `lib/rent-math.ts`
 * does it: `Tenancy.startDate`/`endDate` are bare `DateTime` columns, not
 * `@db.Date`, and the Excel importer writes non-midnight values.
 */

import { TENANCY_STATUSES } from "@kason/shared";

type TenancyStatus = (typeof TENANCY_STATUSES)[number];

/**
 * Which tenancy statuses represent a real agreement whose occupied days must be
 * billed. A `Record` keyed on the status union (NOT a bare array) so adding a
 * status to TENANCY_STATUSES is a compile error here until someone decides
 * whether it bills — the repo's lock-step pattern; an array would silently
 * accept the new member and under-bill it.
 *
 * Only `draft` is excluded: it is a not-yet-real agreement. `ended`,
 * `terminated` and `renewed` all describe tenancies that DID occupy the unit,
 * and their occupied days are owed — excluding them is precisely the defect
 * this module exists to fix.
 */
const BILLABLE_BY_STATUS: Record<TenancyStatus, boolean> = {
  draft: false,
  active: true,
  ended: true,
  terminated: true,
  renewed: true,
};

/**
 * Unknown/legacy statuses (e.g. "expired", written by
 * tenancy.service.ts TERMINAL_TENANCY_STATUSES but absent from
 * TENANCY_STATUSES) default to BILLABLE. Deliberate: an over-inclusive
 * selection produces a visible wrong bill, while an under-inclusive one
 * produces a silently missing bill — the failure mode this module was written
 * to eliminate, and the one the repo's "every money field must reach a real
 * Charge" rule forbids.
 */
export function isBillableStatus(status: string): boolean {
  return BILLABLE_BY_STATUS[status as TenancyStatus] ?? true;
}

/** Integer UTC-day index for a Date's CALENDAR day (time-of-day dropped). */
function dayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
}

/** The Prisma `where` fragment shape {@link tenancyPeriodWhere} produces. */
export type TenancyPeriodWhere = {
  status: { notIn: string[] };
  startDate: { lte: Date };
  OR: Array<{ endDate: null } | { endDate: { gte: Date } }>;
};

/**
 * Derived from BILLABLE_BY_STATUS rather than hand-listed, so the query and the
 * in-memory predicate can never disagree about which statuses bill.
 */
const NON_BILLABLE_STATUSES: string[] = (Object.keys(BILLABLE_BY_STATUS) as TenancyStatus[]).filter(
  (s) => !BILLABLE_BY_STATUS[s],
);

/**
 * The Prisma `where` fragment selecting every tenancy that occupied `month` —
 * the query-side twin of {@link tenancyOverlapsPeriod}. A unit test holds the two
 * to identical answers over a fixture matrix; keep them in lock-step.
 *
 * Note `startDate.lte` is the last INSTANT of the month's last calendar day, not
 * UTC-midnight of it. `Tenancy.startDate` is a bare `DateTime` and the Excel
 * importer writes non-midnight values (e.g. `2026-07-31T16:55:43.898Z`), so
 * comparing against midnight would drop a tenant who moved in that very day.
 */
export function tenancyPeriodWhere(month: Date): TenancyPeriodWhere {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEndInclusive = new Date(Date.UTC(y, m + 1, 1) - 1);
  return {
    status: { notIn: NON_BILLABLE_STATUSES },
    startDate: { lte: monthEndInclusive },
    OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
  };
}

/**
 * How many CALENDAR days of `month` this tenancy occupied. Clamps the tenancy's
 * window to the month exactly as `lib/rent-math.ts` computeProratedRent does —
 * the two must agree, or the day-count shown to an operator would not match the
 * day-count they are billed for.
 */
export function occupiedDaysInPeriod(
  tenancy: { startDate: Date; endDate: Date | null },
  month: Date,
): number {
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m, daysInMonth));
  const winStart = tenancy.startDate > monthStart ? tenancy.startDate : monthStart;
  const winEnd = tenancy.endDate && tenancy.endDate < monthEnd ? tenancy.endDate : monthEnd;
  return Math.max(0, dayIndex(winEnd) - dayIndex(winStart) + 1);
}

/**
 * The single tenancy that best represents `month` for surfaces that can carry
 * only ONE (the grid's per-room row; buildBillRooms's synthesized 1-pax room).
 * Chooses the longest occupancy, so a handover month is attributed to whoever
 * actually lived there for most of it.
 *
 * The tie-break (earliest start, then id) exists because Postgres returns
 * physical order absent an ORDER BY: without it, two half-month tenancies would
 * swap places between page loads and the operator would see the billed tenant
 * flicker. Returns null when no tenancy occupied the month (genuinely vacant).
 *
 * NOTE: this collapses a handover month to one tenant BY DESIGN, for surfaces
 * that cannot represent two. Rent does NOT go through here — each overlapping
 * tenancy is billed its own prorated share via tenancyPeriodWhere.
 */
export function primaryTenancyForPeriod<T extends { id: string; startDate: Date; endDate: Date | null; status: string }>(
  tenancies: readonly T[],
  month: Date,
): T | null {
  const candidates = tenancies.filter((t) => tenancyOverlapsPeriod(t, month));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, t) => {
    const days = occupiedDaysInPeriod(t, month);
    const bestDays = occupiedDaysInPeriod(best, month);
    if (days !== bestDays) return days > bestDays ? t : best;
    if (t.startDate.getTime() !== best.startDate.getTime()) return t.startDate < best.startDate ? t : best;
    return t.id < best.id ? t : best;
  });
}

/**
 * Does this tenancy occupy any day of `month`? Endpoints are INCLUSIVE on both
 * sides — a tenancy ending on the 1st occupied that day, and one starting on the
 * last day occupied that day. `endDate: null` means still-open (no move-out).
 */
export function tenancyOverlapsPeriod(
  tenancy: { startDate: Date; endDate: Date | null; status: string },
  month: Date,
): boolean {
  if (!isBillableStatus(tenancy.status)) return false;
  const y = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const monthStart = dayIndex(new Date(Date.UTC(y, m, 1)));
  const monthEnd = dayIndex(new Date(Date.UTC(y, m + 1, 0)));
  if (dayIndex(tenancy.startDate) > monthEnd) return false;
  return tenancy.endDate === null || dayIndex(tenancy.endDate) >= monthStart;
}
