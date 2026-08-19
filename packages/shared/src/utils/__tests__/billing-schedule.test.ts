import { describe, it, expect } from "vitest";
import {
  addMonthsToYm,
  autoBillPeriodRange,
  describeAutoBillDay,
  describeBillPeriodOffset,
  findMissingBillingPeriods,
  isAutoBillDueOn,
  resolveBillingPeriod,
  ymOfUtc,
  AUTO_BILL_DAY_MAX,
  AUTO_BILL_DAY_MIN,
  BILL_PERIOD_OFFSET_MIN,
  BILL_PERIOD_OFFSET_MAX,
  DEFAULT_BILLING_GAP_LOOKBACK_MONTHS,
} from "../billing-schedule";

describe("ymOfUtc", () => {
  it("zero-pads single-digit months", () => {
    expect(ymOfUtc(new Date("2026-07-25T02:00:00Z"))).toBe("2026-07");
    expect(ymOfUtc(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("reads UTC, not local time — a late-in-month UTC+8 evening must not roll the month", () => {
    // 2026-07-31T18:00Z is 2026-08-01 02:00 in Malaysia (UTC+8). The cron gates on
    // getUTCDate(), so the period must stay 2026-07 or the target month shifts.
    expect(ymOfUtc(new Date("2026-07-31T18:00:00Z"))).toBe("2026-07");
  });
});

describe("addMonthsToYm", () => {
  it("shifts within a year", () => {
    expect(addMonthsToYm("2026-07", 1)).toBe("2026-08");
    expect(addMonthsToYm("2026-07", 2)).toBe("2026-09");
    expect(addMonthsToYm("2026-07", 0)).toBe("2026-07");
  });

  it("rolls the year over at the December boundary", () => {
    expect(addMonthsToYm("2026-12", 1)).toBe("2027-01");
    expect(addMonthsToYm("2026-11", 2)).toBe("2027-01");
    expect(addMonthsToYm("2026-12", 2)).toBe("2027-02");
  });

  it("supports negative shifts (year rolls backward)", () => {
    expect(addMonthsToYm("2026-01", -1)).toBe("2025-12");
  });

  it("throws on a malformed month instead of producing NaN-NaN", () => {
    // A bad period string would become a Charge's billingMonth — fail loudly.
    expect(() => addMonthsToYm("2026-7", 1)).toThrow(/YYYY-MM/);
    expect(() => addMonthsToYm("2026-13", 1)).toThrow(/YYYY-MM/);
    expect(() => addMonthsToYm("2026-00", 1)).toThrow(/YYYY-MM/);
    expect(() => addMonthsToYm("", 1)).toThrow(/YYYY-MM/);
  });

  it("throws on a non-integer month shift", () => {
    expect(() => addMonthsToYm("2026-07", 1.5)).toThrow(/integer/);
  });
});

describe("resolveBillingPeriod", () => {
  const runDay25July = new Date("2026-07-25T02:00:00Z"); // 10:00 MYT on the 25th

  it("offset 1 bills NEXT month — KAEN's process", () => {
    // The whole point of this feature: running on 25 Jul must draft AUGUST.
    expect(resolveBillingPeriod(runDay25July, 1)).toBe("2026-08");
  });

  it("offset 0 preserves the legacy behaviour (bills the run month)", () => {
    expect(resolveBillingPeriod(runDay25July, 0)).toBe("2026-07");
  });

  it("offset 2 bills two months ahead", () => {
    expect(resolveBillingPeriod(runDay25July, 2)).toBe("2026-09");
  });

  it("a December run with offset 1 bills the following January", () => {
    expect(resolveBillingPeriod(new Date("2026-12-25T02:00:00Z"), 1)).toBe("2027-01");
  });
});

describe("describeBillPeriodOffset", () => {
  it("reads as plain English for every accepted offset", () => {
    expect(describeBillPeriodOffset(0)).toBe("the current month");
    expect(describeBillPeriodOffset(1)).toBe("next month");
    expect(describeBillPeriodOffset(2)).toBe("2 months ahead");
  });
});

describe("offset bounds", () => {
  it("exposes the range every layer validates against", () => {
    expect(BILL_PERIOD_OFFSET_MIN).toBe(0);
    expect(BILL_PERIOD_OFFSET_MAX).toBe(2);
  });
});

describe("findMissingBillingPeriods", () => {
  // The reported defect, reduced to its arithmetic. KAEN moved billPeriodOffset
  // 0 → 1 between the July and August runs: the 25 Jul run (offset 0) drafted
  // July, the 25 Aug run (offset 1) drafts September, and NOTHING ever drafts
  // August. Rent for August simply does not exist and no surface says so.
  it("reports the month an offset change skipped over", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-05", "2026-06", "2026-07"],
        targetPeriod: "2026-09",
        lookbackMonths: 6,
      }),
    ).toEqual(["2026-08"]);
  });

  it("reports nothing when every prior month was drafted", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-06", "2026-07", "2026-08"],
        targetPeriod: "2026-09",
        lookbackMonths: 3,
      }),
    ).toEqual([]);
  });

  // The target is being drafted by the very run that asks — reporting it would
  // make every healthy run cry gap.
  it("never reports the target period itself", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-07", "2026-08"],
        targetPeriod: "2026-09",
        lookbackMonths: 3,
      }),
    ).toEqual([]);
  });

  it("reports several consecutive missed months, oldest first", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-05"],
        targetPeriod: "2026-09",
        lookbackMonths: 4,
      }),
    ).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("crosses the year boundary, reporting each gap in the run history", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-09", "2026-11"],
        targetPeriod: "2027-01",
        lookbackMonths: 4,
      }),
    ).toEqual(["2026-10", "2026-12"]);
  });

  // Without a floor, an org that started billing in July reports every month
  // back to the lookback horizon as "missing" on its first ever run.
  it("never reports a period before the org started billing", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: [],
        targetPeriod: "2026-09",
        lookbackMonths: 12,
        earliestPeriod: "2026-07",
      }),
    ).toEqual(["2026-07", "2026-08"]);
  });

  it("treats an earliestPeriod at or after the target as nothing to check", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: [],
        targetPeriod: "2026-09",
        lookbackMonths: 12,
        earliestPeriod: "2026-09",
      }),
    ).toEqual([]);
  });

  it("honours the lookback horizon rather than scanning all history", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: [],
        targetPeriod: "2026-09",
        lookbackMonths: 2,
      }),
    ).toEqual(["2026-07", "2026-08"]);
  });

  it("is order- and duplicate-insensitive about what was drafted", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2026-08", "2026-06", "2026-08", "2026-06"],
        targetPeriod: "2026-09",
        lookbackMonths: 3,
      }),
    ).toEqual(["2026-07"]);
  });

  it("ignores drafted periods outside the window, including the future", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: ["2025-01", "2027-05"],
        targetPeriod: "2026-09",
        lookbackMonths: 1,
      }),
    ).toEqual(["2026-08"]);
  });

  it("a zero lookback checks nothing", () => {
    expect(
      findMissingBillingPeriods({
        draftedPeriods: [],
        targetPeriod: "2026-09",
        lookbackMonths: 0,
      }),
    ).toEqual([]);
  });

  // A malformed period would otherwise silently become a "NaN-NaN" gap report,
  // or worse, a periodMonth someone drafts against.
  it("throws on a malformed period rather than reporting nonsense", () => {
    expect(() =>
      findMissingBillingPeriods({ draftedPeriods: [], targetPeriod: "2026-13", lookbackMonths: 3 }),
    ).toThrow();
    expect(() =>
      findMissingBillingPeriods({ draftedPeriods: ["nope"], targetPeriod: "2026-09", lookbackMonths: 3 }),
    ).toThrow();
    expect(() =>
      findMissingBillingPeriods({
        draftedPeriods: [],
        targetPeriod: "2026-09",
        lookbackMonths: 3,
        earliestPeriod: "2026-00",
      }),
    ).toThrow();
  });

  it("rejects a negative or fractional lookback", () => {
    expect(() =>
      findMissingBillingPeriods({ draftedPeriods: [], targetPeriod: "2026-09", lookbackMonths: -1 }),
    ).toThrow();
    expect(() =>
      findMissingBillingPeriods({ draftedPeriods: [], targetPeriod: "2026-09", lookbackMonths: 1.5 }),
    ).toThrow();
  });

  it("exposes a default horizon the cron and any caller share", () => {
    expect(DEFAULT_BILLING_GAP_LOOKBACK_MONTHS).toBe(6);
  });
});

describe("isAutoBillDueOn — the auto-BILL day gate", () => {
  const on = (day: number, autoBillDay: number | null) =>
    isAutoBillDueOn(new Date(Date.UTC(2026, 7, day)), autoBillDay);

  it("is OFF whenever no day is configured — null must never bill", () => {
    // The whole safety story rests on this: an org that never touched the
    // setting keeps the human approval gate.
    expect(on(1, null)).toBe(false);
    expect(on(28, null)).toBe(false);
  });

  it("fires ON the configured day", () => {
    expect(on(1, 1)).toBe(true);
    expect(on(25, 25)).toBe(true);
  });

  it("keeps firing AFTER the day, so a mid-month move-in still gets billed", () => {
    // This is the difference from the DRAFT cron's equality gate, and it is the
    // entire reason a tenant who moves in on the 12th does not wait a month.
    expect(on(13, 1)).toBe(true);
    expect(on(28, 1)).toBe(true);
  });

  it("does NOT fire before the day", () => {
    expect(on(24, 25)).toBe(false);
    expect(on(1, 2)).toBe(false);
  });

  it("refuses a non-integer day rather than coercing it", () => {
    expect(on(15, 1.5)).toBe(false);
    expect(on(15, NaN)).toBe(false);
  });

  it("reads the date in UTC, matching the cron's own clock", () => {
    // 23:00 UTC on the 14th is already the 15th in Malaysia (UTC+8). The cron
    // gates on getUTCDate(), so this must still read as the 14th.
    expect(isAutoBillDueOn(new Date("2026-08-14T23:00:00Z"), 15)).toBe(false);
    expect(isAutoBillDueOn(new Date("2026-08-15T00:00:00Z"), 15)).toBe(true);
  });

  it("bounds agree with the schema and the DB CHECK", () => {
    expect(AUTO_BILL_DAY_MIN).toBe(1);
    expect(AUTO_BILL_DAY_MAX).toBe(28);
  });
});

describe("autoBillPeriodRange — what auto-billing is allowed to touch", () => {
  const AUG = new Date(Date.UTC(2026, 7, 1));

  it("collapses to the current month at offset 0", () => {
    expect(autoBillPeriodRange(AUG, 0)).toEqual({ from: "2026-08", to: "2026-08" });
  });

  it("reaches the drafted month at offset 1 — KAEN issues the coming month", () => {
    // Without the upper end, a 25th run at offset 1 would draft September and
    // then bill nothing at all on the very day KAEN issues.
    expect(autoBillPeriodRange(AUG, 1)).toEqual({ from: "2026-08", to: "2026-09" });
  });

  it("never starts before the current month, so a past draft is never swept", () => {
    const range = autoBillPeriodRange(AUG, 2);
    expect(range.from).toBe("2026-08");
    expect(range.to).toBe("2026-10");
  });

  it("rolls the year over", () => {
    expect(autoBillPeriodRange(new Date(Date.UTC(2026, 11, 1)), 1)).toEqual({
      from: "2026-12",
      to: "2027-01",
    });
  });

  it("clamps an inverted band rather than silently matching nothing", () => {
    // Unreachable through zod + the DB CHECK, but a band whose end precedes its
    // start would make the cron a silent no-op — fail visible, not quiet.
    expect(autoBillPeriodRange(AUG, -1)).toEqual({ from: "2026-08", to: "2026-08" });
  });
});

describe("describeAutoBillDay", () => {
  it("says plainly that nothing is automatic when off", () => {
    expect(describeAutoBillDay(null)).toContain("never automatically");
  });

  it("names the day and the on-or-after behaviour when on", () => {
    const s = describeAutoBillDay(1);
    expect(s).toContain("day 1");
    expect(s).toContain("mid-month");
  });
});
