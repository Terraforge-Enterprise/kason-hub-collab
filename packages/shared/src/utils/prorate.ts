// packages/shared/src/utils/prorate.ts
import { centsToString, toCents } from "./money-cents";

export interface ProrateResult {
  /** Cent-rounded 2dp string, e.g. "750.00" */
  amount: string;
  billableDays: number;
  daysInMonth: number;
}

const DAY_MS = 86_400_000;

function utcDayFloor(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Pro-rate a monthly amount over the overlap (inclusive of both end days)
 * between [periodStart, periodEnd] and the calendar month containing
 * anchorMonth. Integer-cent math; Math.round half-up; deterministic.
 */
export function prorateAmount(
  monthlyAmount: string | number,
  periodStart: Date,
  periodEnd: Date,
  anchorMonth: Date,
): ProrateResult {
  const start = utcDayFloor(periodStart);
  const end = utcDayFloor(periodEnd);
  if (end < start) throw new Error("prorateAmount: periodEnd before periodStart");

  const y = anchorMonth.getUTCFullYear();
  const m = anchorMonth.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const monthStart = Date.UTC(y, m, 1);
  const monthEnd = Date.UTC(y, m, daysInMonth);

  const overlapStart = Math.max(start, monthStart);
  const overlapEnd = Math.min(end, monthEnd);
  const billableDays = overlapEnd >= overlapStart ? Math.round((overlapEnd - overlapStart) / DAY_MS) + 1 : 0;

  const amountCents = Math.round((toCents(monthlyAmount, "prorateAmount") * billableDays) / daysInMonth);
  return { amount: centsToString(amountCents), billableDays, daysInMonth };
}
