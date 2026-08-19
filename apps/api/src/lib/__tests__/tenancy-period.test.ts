import { describe, it, expect } from "vitest";
import { tenancyOverlapsPeriod, tenancyPeriodWhere, primaryTenancyForPeriod } from "../tenancy-period";

const U = (s: string) => new Date(`${s}T00:00:00.000Z`);
const JULY = U("2026-07-01");

type Row = { label: string; startDate: Date; endDate: Date | null; status: string };

/**
 * The real-world fixture matrix, drawn from the A-03-03 defect plus the handover
 * the operator described. Shared by the predicate and the where-clause tests so
 * both are held to the SAME expected answers.
 */
const ROWS: Array<Row & { occupiesJuly: boolean }> = [
  // A-03-03 as it actually is in the DB.
  { label: "A-03-03 July occupant (ended)", startDate: U("2026-07-01"), endDate: U("2026-07-31"), status: "ended", occupiesJuly: true },
  { label: "A-03-03 replacement (starts Aug 1)", startDate: U("2026-08-01"), endDate: U("2027-08-31"), status: "active", occupiesJuly: false },
  // The operator's mid-month handover.
  { label: "handover outgoing (Jul 1-14)", startDate: U("2026-07-01"), endDate: U("2026-07-14"), status: "terminated", occupiesJuly: true },
  { label: "handover incoming (Jul 15 on)", startDate: U("2026-07-15"), endDate: U("2027-07-14"), status: "active", occupiesJuly: true },
  // Statuses that must stay billable.
  { label: "renewed tenancy spanning July", startDate: U("2026-01-01"), endDate: U("2026-12-31"), status: "renewed", occupiesJuly: true },
  { label: "draft tenancy spanning July", startDate: U("2026-01-01"), endDate: U("2026-12-31"), status: "draft", occupiesJuly: false },
  // Boundaries.
  { label: "ends on July 1", startDate: U("2026-01-01"), endDate: U("2026-07-01"), status: "ended", occupiesJuly: true },
  { label: "ended June 30", startDate: U("2026-01-01"), endDate: U("2026-06-30"), status: "ended", occupiesJuly: false },
  { label: "starts July 31 (non-midnight)", startDate: new Date("2026-07-31T16:55:43.898Z"), endDate: null, status: "active", occupiesJuly: true },
  { label: "open-ended from March", startDate: U("2026-03-01"), endDate: null, status: "active", occupiesJuly: true },
];

describe("tenancyOverlapsPeriod", () => {
  it("selects a tenancy that covers the whole month", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-01-01"), endDate: U("2026-12-31"), status: "active" }, JULY),
    ).toBe(true);
  });

  // B6 — a `draft` tenancy is a not-yet-real agreement. Billing one would invoice a
  // tenant who never moved in, so status IS consulted even though every other
  // non-draft status (ended/terminated/renewed) must stay selectable.
  it("never selects a draft tenancy", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-01-01"), endDate: U("2026-12-31"), status: "draft" }, JULY),
    ).toBe(false);
  });

  // B4 — the reported defect's direct cause: A-03-03's replacement tenancy starts
  // 2026-08-01, so pricing July against it yields zero occupied days -> RM0.00.
  it("rejects a tenancy that starts after the month", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-08-01"), endDate: U("2027-08-31"), status: "active" }, JULY),
    ).toBe(false);
  });

  // B5 — endDate null means still-open, not "ended long ago".
  it("selects an open-ended tenancy for later months", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-03-01"), endDate: null, status: "active" }, JULY),
    ).toBe(true);
  });

  // B7/B8/B9 — inclusive endpoints. A tenant who moved out on the 1st occupied the
  // 1st; a tenant who moved in on the 31st occupied the 31st. Off-by-one here
  // silently drops or invents a day of rent.
  it("includes a tenancy ending on the first of the month", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-01-01"), endDate: U("2026-07-01"), status: "ended" }, JULY),
    ).toBe(true);
  });

  it("includes a tenancy starting on the last day of the month", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-07-31"), endDate: null, status: "active" }, JULY),
    ).toBe(true);
  });

  it("excludes a tenancy that ended the previous month", () => {
    expect(
      tenancyOverlapsPeriod({ startDate: U("2026-01-01"), endDate: U("2026-06-30"), status: "ended" }, JULY),
    ).toBe(false);
  });

  // B10 — Tenancy.startDate/endDate are bare DateTime (not @db.Date) and the Excel
  // importer writes non-midnight values; comparisons must be calendar-day based.
  it("is immune to non-midnight timestamps", () => {
    expect(
      tenancyOverlapsPeriod(
        {
          startDate: new Date("2026-07-31T16:55:43.898Z"),
          endDate: null,
          status: "active",
        },
        JULY,
      ),
    ).toBe(true);
    // Mirror: a late-in-the-day move-out on the previous month's last day is still out.
    expect(
      tenancyOverlapsPeriod(
        {
          startDate: U("2026-01-01"),
          endDate: new Date("2026-06-30T23:59:59.999Z"),
          status: "ended",
        },
        JULY,
      ),
    ).toBe(false);
  });
});

/**
 * Tiny interpreter for the Prisma `where` fragment tenancyPeriodWhere returns.
 * Its job is to prove the SQL the DB will run selects exactly the rows the pure
 * predicate selects. Without this, the JS predicate and the query can drift —
 * and a drift here is invisible until a month silently bills the wrong tenant.
 */
function matchesWhere(where: ReturnType<typeof tenancyPeriodWhere>, row: Row): boolean {
  if (where.status?.notIn?.includes(row.status)) return false;
  if (where.startDate?.lte !== undefined && row.startDate > where.startDate.lte) return false;
  const or = where.OR;
  if (or) {
    const ok = or.some((clause) => {
      if ("endDate" in clause && clause.endDate === null) return row.endDate === null;
      const gte = (clause as { endDate: { gte: Date } }).endDate?.gte;
      return gte !== undefined && row.endDate !== null && row.endDate >= gte;
    });
    if (!ok) return false;
  }
  return true;
}

describe("tenancyPeriodWhere", () => {
  // B2 + B3 — the selection the DB performs must include BOTH sides of a handover
  // and must NOT drop a month's real occupant just because that tenancy has since
  // ended. This is the query-level statement of the reported defect.
  it("selects exactly the tenancies that occupied the month", () => {
    const where = tenancyPeriodWhere(JULY);
    const selected = ROWS.filter((r) => matchesWhere(where, r)).map((r) => r.label);
    expect(selected).toEqual(ROWS.filter((r) => r.occupiesJuly).map((r) => r.label));
  });

  // Lock-step guard: the query and the in-memory predicate are two encodings of one
  // rule. If they ever disagree on any fixture row, one of them is wrong.
  it("agrees with tenancyOverlapsPeriod on every fixture row", () => {
    const where = tenancyPeriodWhere(JULY);
    for (const row of ROWS) {
      expect({ label: row.label, viaWhere: matchesWhere(where, row) }).toEqual({
        label: row.label,
        viaWhere: tenancyOverlapsPeriod(row, JULY),
      });
    }
  });
});

describe("primaryTenancyForPeriod", () => {
  const outgoing = { id: "t-out", startDate: U("2026-07-01"), endDate: U("2026-07-14"), status: "terminated" };
  const incoming = { id: "t-in", startDate: U("2026-07-15"), endDate: U("2027-07-14"), status: "active" };
  const future = { id: "t-future", startDate: U("2026-08-01"), endDate: null, status: "active" };

  // B11 — the grid row and buildBillRooms can each carry only ONE tenancy. Picking
  // "whoever is active now" is what produced the RM0.00; pick whoever occupied the
  // most days of the month instead.
  it("picks the longest-occupancy tenancy as primary", () => {
    // incoming holds 17 of July's 31 days, outgoing 14.
    expect(primaryTenancyForPeriod([outgoing, incoming], JULY)?.id).toBe("t-in");
  });

  it("ignores tenancies that do not occupy the month", () => {
    expect(primaryTenancyForPeriod([future, outgoing], JULY)?.id).toBe("t-out");
  });

  it("returns null when no tenancy occupied the month", () => {
    expect(primaryTenancyForPeriod([future], JULY)).toBeNull();
  });

  // Determinism matters: two half-month tenancies must not flip between page loads
  // depending on Postgres row order.
  it("breaks an equal-days tie by earliest start, then id", () => {
    const a = { id: "t-b", startDate: U("2026-07-01"), endDate: U("2026-07-15"), status: "ended" };
    const b = { id: "t-a", startDate: U("2026-07-17"), endDate: U("2026-07-31"), status: "active" };
    // Both hold 15 days; the earlier start wins regardless of input order.
    expect(primaryTenancyForPeriod([a, b], JULY)?.id).toBe("t-b");
    expect(primaryTenancyForPeriod([b, a], JULY)?.id).toBe("t-b");
  });
});
