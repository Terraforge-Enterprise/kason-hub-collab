/**
 * Advance-billing SCHEDULE math — which month a scheduled draft run should bill.
 * ONE implementation shared by the auto-draft cron and the admin web UI, so the
 * two can never disagree about which month a run will bill.
 *
 * Not to be confused with `./billing-month.ts`, which answers a different
 * question: the first-of-month period KEY for an existing Charge. This file is
 * about scheduling ("which month will the 25th draft?"); that one is about
 * classifying a row that already exists.
 *
 * This is deliberately in @kason/shared rather than duplicated per app: a second
 * copy of a month calculation is the lock-step drift trap — the UI promises "bills
 * Sep 2026" while the cron drafts Aug, and nothing type-checks the disagreement.
 *
 * `billPeriodOffset` is whole months AHEAD of the RUN month:
 *   0 = draft the run month itself (the pre-2026-07 behaviour)
 *   1 = draft NEXT month — KAEN's process: run on the 25th, bill the coming month
 *
 * All arithmetic is UTC because the cron gates on `now.getUTCDate()` — mixing a
 * local-time month in here would shift the target period for anyone east of UTC
 * (Malaysia is UTC+8, so a local read late on the 31st lands in the next month).
 */

/** Lowest/highest offsets accepted anywhere (schema, API, UI all read these). */
export const BILL_PERIOD_OFFSET_MIN = 0;
export const BILL_PERIOD_OFFSET_MAX = 2;

/**
 * The offsets offered in the UI, filtered to the range the zod schema and the DB
 * CHECK constraint enforce. Derived from the bounds rather than hand-listed, so
 * widening MAX can never leave the picker unable to express a value the API accepts.
 * "Next month" leads because it is KAEN's process.
 */
export const BILL_PERIOD_CHOICES: ReadonlyArray<{ value: number; label: string }> = (
  [
    { value: 1, label: "Next month" },
    { value: 0, label: "Current month" },
    { value: 2, label: "In 2 months" },
  ] as const
).filter((o) => o.value >= BILL_PERIOD_OFFSET_MIN && o.value <= BILL_PERIOD_OFFSET_MAX);

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Zero-padded "YYYY-MM" for a Date, read in UTC (matches the cron's clock). */
export function ymOfUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Shift a "YYYY-MM" by whole months, rolling the year over. Never mutates input.
 * Throws on a malformed month rather than silently returning "NaN-NaN" — a bad
 * period string here would become a Charge's billingMonth.
 */
export function addMonthsToYm(ym: string, months: number): string {
  if (!YM_RE.test(ym)) throw new Error(`addMonthsToYm: expected YYYY-MM, got ${JSON.stringify(ym)}`);
  if (!Number.isInteger(months)) throw new Error(`addMonthsToYm: months must be an integer, got ${months}`);
  const [y, m] = ym.split("-").map(Number);
  // Date.UTC normalises an out-of-range month index into the correct year.
  return ymOfUtc(new Date(Date.UTC(y, m - 1 + months, 1)));
}

/**
 * The period a run started at `now` should draft, given the org's offset.
 * The single source of truth for "which month does the run day bill?".
 */
export function resolveBillingPeriod(now: Date, billPeriodOffset: number): string {
  return addMonthsToYm(ymOfUtc(now), billPeriodOffset);
}

/**
 * How far back a gap check looks by default. Six months is long enough to catch
 * a missed run or an offset change that nobody noticed for a quarter, short
 * enough that the query stays a trivial index scan on
 * (organizationId, periodMonth).
 */
export const DEFAULT_BILLING_GAP_LOOKBACK_MONTHS = 6;

/**
 * The billing months that SHOULD have been drafted before `targetPeriod` but
 * never were.
 *
 * The auto-draft cron drafts exactly ONE month per run — `resolveBillingPeriod`
 * of the day it happens to fire — and gates on `runDayOfMonth === today`. Miss
 * that day (host down, flag off, config toggled inactive) and the month is gone:
 * nothing re-drafts it and no surface says so. Changing `billPeriodOffset`
 * skips a month by construction — a 25 Jul run at offset 0 drafts July, the
 * 25 Aug run at offset 1 drafts September, and August is never billed at all.
 * That is not hypothetical: it is why a tenant's August rent charge did not
 * exist while every August utility did.
 *
 * This reports gaps; it deliberately does NOT draft them. Minting rent for a
 * past month is a money-visible act that can also land in a frozen owner-
 * statement period, so recovery stays an explicit admin action through the
 * existing per-period draft endpoint. The value here is that the gap stops
 * being invisible.
 *
 * ── Which months count as "should have been drafted" ─────────────────────────
 * The window is bounded below by, in order of preference:
 *   1. `earliestPeriod` when the caller knows when the org started billing, else
 *   2. the OLDEST period actually drafted — an org whose history starts in May
 *      has no gap in April; it simply did not exist yet, and
 *   3. `targetPeriod - lookbackMonths`, whichever of the above is later.
 * Without that floor, every org reports a full lookback of phantom gaps on its
 * first ever run, and a real gap becomes noise nobody reads.
 *
 * `targetPeriod` itself is never reported: the run asking the question is the
 * run drafting it.
 *
 * Returns "YYYY-MM" ascending. Throws on any malformed period rather than
 * reporting a "NaN-NaN" month — a bad value here would become the periodMonth
 * an admin drafts against.
 */
export function findMissingBillingPeriods(input: {
  draftedPeriods: readonly string[];
  targetPeriod: string;
  lookbackMonths: number;
  earliestPeriod?: string | null;
}): string[] {
  const { draftedPeriods, targetPeriod, lookbackMonths, earliestPeriod } = input;

  if (!Number.isInteger(lookbackMonths) || lookbackMonths < 0) {
    throw new Error(
      `findMissingBillingPeriods: lookbackMonths must be a non-negative integer, got ${lookbackMonths}`,
    );
  }
  // Shape-validates the target (throws on "2026-13"), and normalising through
  // the same helper keeps every comparison below on identical zero-padded text.
  const target = addMonthsToYm(targetPeriod, 0);

  // Validate every drafted entry. A silently-dropped bad value would read as
  // "that month was never drafted" and manufacture a false gap.
  const drafted = new Set<string>();
  for (const p of draftedPeriods) drafted.add(addMonthsToYm(p, 0));

  // "YYYY-MM" is zero-padded and fixed-width, so lexical order IS chronological
  // order — no date parsing needed to take a minimum or compare.
  let floor = lookbackMonths === 0 ? target : addMonthsToYm(target, -lookbackMonths);
  const oldestDrafted = drafted.size > 0 ? [...drafted].sort()[0] : null;
  if (oldestDrafted !== null && oldestDrafted > floor) floor = oldestDrafted;
  if (earliestPeriod != null) {
    const explicit = addMonthsToYm(earliestPeriod, 0);
    if (explicit > floor) floor = explicit;
  }

  const missing: string[] = [];
  for (let back = lookbackMonths; back >= 1; back--) {
    const period = addMonthsToYm(target, -back);
    if (period < floor) continue;
    if (drafted.has(period)) continue;
    missing.push(period);
  }
  return missing;
}

/**
 * Admin-facing one-liner for the schedule preview, e.g.
 *   "On day 25 each month, drafts invoices for the NEXT month."
 * Kept beside the math so the sentence can never drift from the behaviour.
 */
export function describeBillPeriodOffset(billPeriodOffset: number): string {
  if (billPeriodOffset === 0) return "the current month";
  if (billPeriodOffset === 1) return "next month";
  return `${billPeriodOffset} months ahead`;
}

// ─── Scheduled AUTO-BILLING ───────────────────────────────────────────────────
//
// Drafting and billing are two different acts on two different days:
//   • DRAFT  (runDayOfMonth)      — create the invoice; nobody owes anything yet.
//   • BILL   (autoBillDayOfMonth) — approve it; charges post, documents issue,
//                                   the tenant owes money.
// Both are capped at 28 for the same reason: a day that does not exist in every
// month would silently skip February, and a skipped BILLING day is money that
// never gets charged.

/** Same 1–28 bound as runDayOfMonth (see above), mirrored by a DB CHECK. */
export const AUTO_BILL_DAY_MIN = 1;
export const AUTO_BILL_DAY_MAX = 28;

/**
 * Is scheduled auto-billing due to run today?
 *
 * ON-OR-AFTER, not equality — and that difference is the whole point.
 *
 * The DRAFT cron gates on `runDayOfMonth === today` because drafting a month
 * twice is meaningless: the run is a single cohort event. Billing is not. Drafts
 * keep APPEARING through the month — a tenant who moves in on the 12th gets a
 * prorated draft from draftCatchupForTenancy on the 12th. Under equality that
 * draft would sit unissued until the NEXT month's bill day, which is the exact
 * complaint this feature exists to fix ("a human must click, or nothing gets
 * billed").
 *
 * Running every day from the bill day onward is safe because billing is
 * idempotent: approveBulkService only moves invoices that are still `draft`, so
 * a second pass over an already-billed month approves nothing and posts nothing.
 *
 * UTC to match the cron's clock (`now.getUTCDate()`), like every other date
 * comparison in this file.
 */
export function isAutoBillDueOn(now: Date, autoBillDayOfMonth: number | null): boolean {
  if (autoBillDayOfMonth == null) return false; // NULL = auto-billing is off
  if (!Number.isInteger(autoBillDayOfMonth)) return false;
  return now.getUTCDate() >= autoBillDayOfMonth;
}

/**
 * The INCLUSIVE band of periods scheduled auto-billing may touch, as "YYYY-MM".
 *
 * Bounded on both ends, deliberately:
 *  • `from` = the CURRENT month. Auto-billing never reaches into a past month.
 *    That mirrors the drafting side (draft-catchup.hook.ts: "Months BEFORE this
 *    one stay manual") and protects two things at once — a frozen owner-statement
 *    period, and any old draft an admin parked on purpose rather than issued.
 *  • `to` = the org's draft target month (current + billPeriodOffset). Under
 *    KAEN's process (run day 25, offset 1) the drafts that exist on the 25th are
 *    NEXT month's, so a band ending at the current month would bill nothing at
 *    all on the very day KAEN issues.
 *
 * With offset 0 the band collapses to a single month, which is the common case.
 */
export function autoBillPeriodRange(
  now: Date,
  billPeriodOffset: number,
): { from: string; to: string } {
  const from = ymOfUtc(now);
  const to = resolveBillingPeriod(now, billPeriodOffset);
  // Defensive: a negative offset would invert the band and silently match
  // nothing. The zod schema and the DB CHECK both floor it at 0, so this is a
  // belt-and-braces clamp rather than a reachable branch.
  return { from, to: to < from ? from : to };
}

/**
 * Admin-facing one-liner for the auto-bill preview. Mirrors
 * describeBillPeriodOffset: the sentence lives beside the math so the UI cannot
 * promise something the cron does not do.
 */
export function describeAutoBillDay(autoBillDayOfMonth: number | null): string {
  if (autoBillDayOfMonth == null) {
    return "never automatically — an admin issues drafts from the approvals queue";
  }
  return `on day ${autoBillDayOfMonth} (and any later day that month, so a mid-month move-in is billed too)`;
}
