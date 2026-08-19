// packages/shared/src/utils/billing-month.ts
//
// Period KEY for an existing Charge. For the other direction — which month a
// scheduled auto-draft run should bill (advance billing) — see
// ./billing-schedule.ts.
export interface BillingMonthSource {
  dueDate: Date | string;
  chargeableFrom?: Date | string | null;
  billingMonth?: Date | string | null;
}

/**
 * First-of-month (UTC) period key for a Charge. Priority:
 * billingMonth (Phase-2 column) → chargeableFrom → dueDate.
 * Works on legacy rows where billingMonth is NULL — the Rental Tracker
 * matrix keys on this everywhere.
 */
export function chargeBillingMonth(charge: BillingMonthSource): Date {
  const src = charge.billingMonth ?? charge.chargeableFrom ?? charge.dueDate;
  const d = new Date(src);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
