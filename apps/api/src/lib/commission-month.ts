// Letting-commission month resolution (single source of truth).
//
// "First month rent is KAEN's commission": the FIRST FULL calendar month of a
// tenancy is KAEN's letting commission (KAEN revenue), NOT the owner's rent. The
// prorated move-in month (when move-in is not on the 1st) is NEVER the commission
// month — it is ordinary owner rent. Exactly ONE month is ever the commission.
//
// This pure resolver is shared by the tenancy preview (rent-preview.ts) AND the
// billing poster/auto-draft, so what the setup screen promises === what actually
// bills (poster-faithfulness). Do NOT re-implement this rule anywhere else.

/**
 * The first FULL calendar month contained in [startDate, endDate], or null when the
 * tenancy has no full month. Move-in on the 1st → that month; move-in mid-month → the
 * NEXT month (the prorated move-in month is never the commission month). The candidate
 * month must end on/before endDate to count (a tenancy that ends before the month is out
 * has no commission). Keys on getUTC* — dates are UTC-midnight everywhere in billing.
 *
 * Ported verbatim from rent-preview.ts computeFirstMonthCommission so preview === poster.
 */
export function resolveCommissionMonth(
  startDate: Date,
  endDate: Date | null,
): { year: number; month0: number } | null {
  if (Number.isNaN(startDate.getTime())) return null;
  if (endDate !== null && Number.isNaN(endDate.getTime())) return null;

  const sy = startDate.getUTCFullYear();
  const sm = startDate.getUTCMonth();
  const startsOnFirst = startDate.getUTCDate() === 1;
  const cy = startsOnFirst ? sy : sm === 11 ? sy + 1 : sy;
  const cm = startsOnFirst ? sm : (sm + 1) % 12;

  // The candidate month's last day (UTC midnight) must be on/before endDate.
  const commissionMonthEnd = new Date(Date.UTC(cy, cm + 1, 0));
  if (endDate && endDate < commissionMonthEnd) return null;

  return { year: cy, month0: cm };
}

/**
 * Is `month` the tenancy's commission month? False unless firstMonthIsCommission is set
 * AND `month` is exactly the single resolved commission month. Every other month
 * (including the prorated move-in month) is false → ordinary owner rent.
 */
export function isCommissionMonth(
  input: { startDate: Date; endDate: Date | null; firstMonthIsCommission: boolean },
  month: Date,
): boolean {
  if (!input.firstMonthIsCommission) return false;
  const cm = resolveCommissionMonth(input.startDate, input.endDate);
  if (!cm) return false;
  return month.getUTCFullYear() === cm.year && month.getUTCMonth() === cm.month0;
}

/**
 * The chargeType the poster/auto-draft should write for `month`: "letting_commission"
 * ONLY on the single commission month while the flag is enabled, else "rent". This is the
 * one decision that flips a month between KAEN revenue (IVTEN) and owner rent (RB), shared
 * by every mint site so preview === poster === auto-draft. Flag off → always "rent"
 * (byte-identical to today).
 */
export function monthlyChargeType(
  tenancy: { startDate: Date; endDate: Date | null; firstMonthIsCommission: boolean },
  month: Date,
  lettingCommissionEnabled: boolean,
): "rent" | "letting_commission" {
  return lettingCommissionEnabled && isCommissionMonth(tenancy, month) ? "letting_commission" : "rent";
}
