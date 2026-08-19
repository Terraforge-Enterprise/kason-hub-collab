import type { PortalUnit } from "../domain/types";

export type OccupancyClass =
  | "ready"          // readyNow === true OR occupancyStatus === "vacant" (with no future moveInDate)
  | "upcoming"       // moveInDate is today or in the future (checked first — beats vacant status)
  | "ending-soon"    // active tenancy whose endDate falls within [today, today+windowDays] (both inclusive)
  | "occupied";      // anything else (open-ended lease, stale moveInDate, end date past or beyond window)

// Normalize to a YYYY-MM-DD UTC day-key. Strings must be ISO-formatted
// (the portal repository emits Prisma toISOString()) — `new Date(...)`
// throws on garbage so a data-shape regression fails loudly instead of
// silently misclassifying.
const isoDay = (d: Date | string): string => {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`classifyOccupancy: invalid date string ${JSON.stringify(d)}`);
  }
  return date.toISOString().slice(0, 10);
};

export function classifyOccupancy(
  u: PortalUnit,
  windowDays: number,
  today: Date,
): OccupancyClass {
  const todayIso = isoDay(today);

  // Rule 1: future moveInDate beats everything — an incoming tenant is scheduled,
  // so even a vacant unit is no longer "ready" for a new tenant.
  if (u.moveInDate && isoDay(u.moveInDate) >= todayIso) return "upcoming";

  // Rule 2: admin-flagged ready OR admin-marked vacant (no incoming tenant above).
  if (u.readyNow || u.occupancyStatus === "vacant") return "ready";

  // Rule 3: active tenancy ending within the window.
  if (u.currentTenancyEndDate) {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() + windowDays);
    const cutoffIso = isoDay(cutoff);
    const endIso = isoDay(u.currentTenancyEndDate);
    if (endIso >= todayIso && endIso <= cutoffIso) return "ending-soon";
  }

  return "occupied";
}
