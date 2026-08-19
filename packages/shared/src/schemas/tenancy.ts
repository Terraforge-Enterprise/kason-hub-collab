import { z } from "zod";
import { COMMISSION_SST_BEARER } from "../constants/statuses";
import { carparkAssignmentInputSchema } from "./carpark";

export const createLandlordTenancySchema = z.object({
  propertyId: z.string().uuid(),
  landlordId: z.string().uuid(),
  startDate: z.string().min(1),
  endDate: z.string().optional(),
  monthlyRent: z.string().min(1),
  depositAmount: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
});

export const updateLandlordTenancyStatusSchema = z.object({
  landlordTenancyId: z.string().uuid(),
  status: z.string().min(1),
  endDate: z.string().optional(),
  notes: z.string().optional(),
});

// Leading YYYY-MM-DD of an ISO date/datetime string, or null when the value is
// not a real calendar date. Compared as a day, never as an instant: a
// `new Date(a) < new Date(b)` compare resolves "2026-07-15T00:00:00" and
// "2026-07-15T00:00:00+08:00" to the PREVIOUS UTC instant east of UTC, so the
// move-in day itself would be rejected on the UTC+8 servers this runs on.
const isoCalendarDay = (value: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const roundTrips =
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day);
  if (!roundTrips) return null;
  // The leading-day regex is deliberately unanchored so datetime forms
  // ("...T00:00:00+08:00") pass, but that also lets a valid day carry a garbage
  // tail ("2026-08-01T25:00:00", "2026-07-15garbage") -- which `new Date` then
  // rejects, surfacing as a 500 at the Prisma DateTime column instead of a 400.
  // Require the WHOLE string to parse. This is a validity check only, never a
  // day comparison, so it carries none of the timezone hazard the comment above
  // warns about.
  if (Number.isNaN(new Date(value).getTime())) return null;
  return `${year}-${month}-${day}`;
};

// Convert a validated rentInvoiceStartDate into the Date to PERSIST. The value
// must be stored as UTC midnight of the leading CALENDAR DAY, never as
// `new Date(value)`: on a UTC+8 server `new Date("2026-08-01T00:00:00+08:00")`
// is 2026-07-31T16:00Z -- the PREVIOUS UTC day -- which a UTC-day invoice
// compare would then read as one month early. `null`/`undefined`/non-calendar
// input map to `null` (the canonical "no scheduled invoice-start / clear").
export const rentInvoiceStartToUtcDate = (
  value: string | null | undefined,
): Date | null => {
  if (value == null) return null;
  const day = isoCalendarDay(value);
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
};

const invoiceStartRefiner = (
  data: { startDate?: string; rentInvoiceStartDate?: string | null },
  ctx: z.RefinementCtx,
) => {
  // `undefined` = field omitted (don't touch); `null` = explicit clear. Neither
  // carries a date to format-check, so skip both. (== catches null and undefined.)
  if (data.rentInvoiceStartDate == null) return;
  const invoiceDay = isoCalendarDay(data.rentInvoiceStartDate);
  if (!invoiceDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rental invoice start must be a calendar date (YYYY-MM-DD)",
      path: ["rentInvoiceStartDate"],
    });
    return;
  }
  // startDate is absent on the update payload, and is not format-validated on
  // create -- leave that existing leniency alone and simply skip the
  // cross-field check when the move-in day cannot be read.
  if (!data.startDate) return;
  const moveInDay = isoCalendarDay(data.startDate);
  if (!moveInDay) return;
  // ISO YYYY-MM-DD sorts lexicographically in calendar order.
  if (invoiceDay < moveInDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rental invoicing cannot start before the move-in date",
      path: ["rentInvoiceStartDate"],
    });
  }
};

export const createTenancySchema = z
  .object({
    propertyId: z.string().uuid(),
    unitId: z.string().uuid(),
    tenantPartyId: z.string().uuid(),
    // Optional: omitted => createTenancyService generates TEN-{year}-NNNN inside
    // the write transaction, matching what the unit editor, reservation-convert
    // and data-import creators have always done. Still accepted when supplied so
    // API/import callers can carry a legacy code. `.min(1)` keeps "" a hard
    // error rather than a silent request to auto-generate.
    tenancyCode: z.string().min(1).optional(),
    startDate: z.string().min(1),
    endDate: z.string().optional(),
    monthlyRentAmount: z.string().min(1).optional(),
    depositAmount: z.string().optional(),
    billingStatus: z.string().optional(),
    // Nullable: the DB column is nullable and "" is rejected by the calendar-day
    // refiner, so `null` is the canonical "no scheduled invoice-start / clear".
    rentInvoiceStartDate: z.string().nullable().optional(),
    firstMonthRentNote: z.string().optional(),
    firstMonthIsCommission: z.boolean().optional(),
    commissionSstBearer: z.enum(COMMISSION_SST_BEARER).optional(),
    reservationId: z.string().uuid().optional(),
    carparks: z.array(carparkAssignmentInputSchema).optional(),
    // T9: when true, a create onto a unit with an active tenancy closes the
    // incumbent (endDate clamped, never before it started) instead of the
    // default 409 UNIT_HAS_ACTIVE_TENANCY warn. Mirrors convertReservationToTenancy's
    // overwrite flag.
    overwrite: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.monthlyRentAmount && !v.reservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["monthlyRentAmount"], message: "Provide monthlyRentAmount or a reservationId" });
    }
  })
  .superRefine(invoiceStartRefiner);

export const updateTenancySchema = z
  .object({
    tenancyId: z.string().uuid(),
    status: z.string().optional(),
    billingStatus: z.string().optional(),
    endDate: z.string().optional(),
    monthlyRentAmount: z.string().optional(),
    depositAmount: z.string().optional(),
    // Nullable so an invoice-start set on the wrong tenancy can be CLEARED --
    // "" is rejected by the refiner, so `null` is the only unset path.
    rentInvoiceStartDate: z.string().nullable().optional(),
    firstMonthRentNote: z.string().optional(),
    firstMonthIsCommission: z.boolean().optional(),
    commissionSstBearer: z.enum(COMMISSION_SST_BEARER).optional(),
  })
  // Same calendar-day format guard as create. The payload carries no startDate,
  // so the invoice-start >= move-in cross-field check is skipped here (the
  // refiner returns early); the service layer must re-check against the stored
  // Tenancy.startDate before writing.
  .superRefine(invoiceStartRefiner);

// Read-only preview of the first rent charge shown at assign-tenant time.
// Lives in @kason/shared so BOTH the API preview endpoint and the web bundle
// import the same shape; the web must never import from apps/api.
export type FirstMonthPreview = {
  month: string; // "YYYY-MM" — the month this first invoice covers
  amount: number; // RM, 2dp
  occupiedDays: number;
  daysInMonth: number;
  isProrated: boolean;
};

// Read-only preview of the first-month commission KAEN keeps (Phase 1,
// display-only). Amount is the FULL month's rent; sstRate is a flat 0.08 on the
// rental, NOT the per-owner ManagementFeeConfig.sstPercent. Null when the
// tenancy is not a commission tenancy or has no full calendar month.
export type CommissionPreview = {
  month: string; // "YYYY-MM" — the first FULL calendar month
  commissionAmount: number; // RM, 2dp — the full monthlyRentAmount
  sstRate: number; // 0.08, flat
  sstAmount: number; // RM, 2dp — round(commissionAmount * 0.08, 2)
  sstBearer: "owner" | "kaen";
  total: number; // commissionAmount + sstAmount
};

export const renewTenancySchema = z.object({
  tenancyId: z.string().uuid(),
  newTenancyCode: z.string().min(1),
  newStartDate: z.string().min(1),
  newEndDate: z.string().optional(),
  monthlyRentAmount: z.string().min(1),
});
