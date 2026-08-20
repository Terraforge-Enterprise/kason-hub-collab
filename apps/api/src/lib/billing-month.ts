// The org-local "current billing month", shared by every caller that needs to decide
// whether a period is past, current, or future.
//
// Lives in lib/ rather than in bills-grid/service.ts (its original home) because that
// module calls getDb() at import time: any consumer outside the grid that merely wanted
// this one pure date helper pulled the entire grid service — and its DB connection — in
// with it. bills-grid/service.ts re-exports it, so every existing importer is unchanged.
//
// Pure: no DB, no money math, no I/O beyond reading the wall clock.

/**
 * The month (UTC first-of-month, matching `periodMonth`) that is "current" in the org's
 * IANA timezone. A billing period STRICTLY before this is a PAST period, for which
 * re-Bill is refused (rule 1: previous months cannot be re-Billed — the billing period,
 * not the invoice issue date, controls this). Uses the real wall clock, so a caller/test
 * picks its period relative to this.
 *
 * The timezone is load-bearing, not decoration: for a UTC+8 org, a plain UTC "now" reads
 * the wrong month for the first eight hours of every first-of-month, which is precisely
 * when a move-in dated "today" is most likely to be keyed in.
 */
export function currentBillingMonthUTC(orgTimezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: orgTimezone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return new Date(`${year}-${month}-01T00:00:00.000Z`);
}

/** Current and next month are billable; past handling is decided separately. */
export function isBeyondAdvanceBillingWindow(periodMonth: Date, currentMonth: Date): boolean {
  const firstBlockedMonth = new Date(Date.UTC(
    currentMonth.getUTCFullYear(),
    currentMonth.getUTCMonth() + 2,
    1,
  ));
  return periodMonth.getTime() >= firstBlockedMonth.getTime();
}
