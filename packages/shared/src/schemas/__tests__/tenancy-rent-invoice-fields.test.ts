import { describe, it, expect } from "vitest";
import { createTenancySchema, updateTenancySchema, rentInvoiceStartToUtcDate } from "../tenancy";

const base = {
  propertyId: "00000000-0000-4000-8000-000000000000",
  unitId: "11111111-1111-4111-8111-111111111111",
  tenantPartyId: "22222222-2222-4222-8222-222222222222",
  tenancyCode: "TEN-0001",
  startDate: "2026-07-15",
  endDate: "2027-07-14",
  monthlyRentAmount: "3000", // z.string(), not a number
};

describe("createTenancySchema — rent-invoice fields", () => {
  it("accepts rentInvoiceStartDate", () => {
    const parsed = createTenancySchema.parse({ ...base, rentInvoiceStartDate: "2026-08-01" });
    expect(parsed.rentInvoiceStartDate).toBe("2026-08-01");
  });

  it("accepts firstMonthRentNote", () => {
    const parsed = createTenancySchema.parse({ ...base, firstMonthRentNote: "pro-rate" });
    expect(parsed.firstMonthRentNote).toBe("pro-rate");
  });

  it("rejects invoice start before move-in", () => {
    const result = createTenancySchema.safeParse({ ...base, rentInvoiceStartDate: "2026-07-01" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("rentInvoiceStartDate"))).toBe(true);
    }
  });

  // The move-in calendar day is the common case: invoicing starts the month the
  // tenant moves in. An instant-wise `new Date(a) < new Date(b)` compare makes
  // acceptance depend on the string format and the server timezone -- an
  // offset-bearing or datetime-local string resolves to the previous UTC
  // instant. The comparison must be on the calendar day.
  it("accepts invoice start on the move-in calendar day in any ISO format", () => {
    for (const sameDay of ["2026-07-15", "2026-07-15T00:00:00", "2026-07-15T00:00:00+08:00"]) {
      const result = createTenancySchema.safeParse({ ...base, rentInvoiceStartDate: sameDay });
      expect(result.success, `${sameDay} is the move-in day and must be accepted`).toBe(true);
    }
  });

  // `new Date("not-a-date")` is Invalid Date, and every comparison against NaN
  // is false -- so a bare `<` guard silently ACCEPTS garbage, which then reaches
  // the Prisma DateTime column and throws a 500 instead of a clean 400.
  it("rejects a rentInvoiceStartDate that is not a calendar date", () => {
    for (const garbage of ["", "not-a-date", "2026-13-45", "2026-02-30"]) {
      const result = createTenancySchema.safeParse({ ...base, rentInvoiceStartDate: garbage });
      expect(result.success, `${JSON.stringify(garbage)} must be rejected`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("rentInvoiceStartDate"))).toBe(true);
      }
    }
  });

  // Regression (review Wave-1 #1): the leading-day regex is unanchored, so a
  // value with a VALID leading YYYY-MM-DD but a garbage tail
  // ("2026-08-01T25:00:00", "2026-07-15garbage") passed the format guard while
  // `new Date(value)` is Invalid Date -- exactly the 500-at-Prisma the guard
  // claims to prevent. The whole string must parse, not just its date prefix.
  it("rejects a valid leading day followed by garbage", () => {
    for (const garbage of ["2026-08-01T25:00:00", "2026-07-15garbage", "2026-08-01xyz"]) {
      const result = createTenancySchema.safeParse({ ...base, rentInvoiceStartDate: garbage });
      expect(result.success, `${JSON.stringify(garbage)} must be rejected`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("rentInvoiceStartDate"))).toBe(true);
      }
    }
  });

  // Wave-1 #2: the DB column is nullable, so `null` must be accepted (a create
  // with no scheduled invoice-start). z.string() alone would reject it.
  it("accepts an explicit null rentInvoiceStartDate on create", () => {
    const parsed = createTenancySchema.parse({ ...base, rentInvoiceStartDate: null });
    expect(parsed.rentInvoiceStartDate).toBeNull();
  });
});

describe("updateTenancySchema — rent-invoice fields", () => {
  const baseUpdate = { tenancyId: "33333333-3333-4333-8333-333333333333" };

  it("carries rentInvoiceStartDate through the update payload", () => {
    const parsed = updateTenancySchema.parse({ ...baseUpdate, rentInvoiceStartDate: "2026-08-01" });
    expect(parsed.rentInvoiceStartDate).toBe("2026-08-01");
  });

  it("rejects a non-calendar-date rentInvoiceStartDate on update", () => {
    const result = updateTenancySchema.safeParse({ ...baseUpdate, rentInvoiceStartDate: "not-a-date" });
    expect(result.success).toBe(false);
  });

  // Characterization, not an endorsement. `updateTenancySchema` carries no
  // startDate, so the invoice-start >= move-in rule CANNOT be enforced here --
  // the move-in date lives only on the persisted row. The service layer must
  // re-check it against the stored Tenancy.startDate before writing. Until it
  // does, this payload is accepted.
  it("cannot enforce invoice-start >= move-in on update (no startDate in payload)", () => {
    const result = updateTenancySchema.safeParse({ ...baseUpdate, rentInvoiceStartDate: "1990-01-01" });
    expect(result.success).toBe(true);
  });

  // Wave-1 #2: the column is nullable and, unlike depositAmount ("" -> null),
  // "" is rejected by the calendar-day refiner -- so `null` is the only way to
  // CLEAR an invoice-start that was set on the wrong tenancy. Without this the
  // date is permanent once written. `null` must round-trip through the payload.
  it("accepts null rentInvoiceStartDate on update to clear the field", () => {
    const parsed = updateTenancySchema.parse({ ...baseUpdate, rentInvoiceStartDate: null });
    expect(parsed.rentInvoiceStartDate).toBeNull();
  });
});

// Wave-2 #3 (storage helper): the service must persist the CALENDAR DAY, not
// `new Date(value)`. On a UTC+8 server `new Date("2026-08-01T00:00:00+08:00")`
// is 2026-07-31T16:00Z -- the PREVIOUS UTC day -- so a UTC-day invoice compare
// would fire one month early. The stored instant must be UTC midnight of the
// leading calendar day regardless of the input's offset/format.
describe("rentInvoiceStartToUtcDate — calendar-day storage", () => {
  it("stores UTC midnight of the calendar day for every ISO format of the same day", () => {
    for (const value of ["2026-08-01", "2026-08-01T00:00:00", "2026-08-01T00:00:00+08:00", "2026-08-01T23:59:59+08:00"]) {
      const stored = rentInvoiceStartToUtcDate(value);
      expect(stored, `${value} must map to a Date`).toBeInstanceOf(Date);
      expect(stored!.getTime(), `${value} must store 2026-08-01 UTC midnight`).toBe(Date.UTC(2026, 7, 1));
    }
  });

  it("returns null for null, undefined, and non-calendar-date input", () => {
    expect(rentInvoiceStartToUtcDate(null)).toBeNull();
    expect(rentInvoiceStartToUtcDate(undefined)).toBeNull();
    expect(rentInvoiceStartToUtcDate("")).toBeNull();
    expect(rentInvoiceStartToUtcDate("not-a-date")).toBeNull();
    expect(rentInvoiceStartToUtcDate("2026-02-30")).toBeNull();
  });
});
