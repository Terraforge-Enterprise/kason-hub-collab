/**
 * Default-calc for Unit deposit fields. Single source of truth used by
 * BOTH the API (for validator + form-row hints) and the web (for
 * auto-fill in deposit fields). Per spec §6.1.
 *
 * NULL inputs propagate — if rentalRate is null, the calc returns null.
 * Override semantics live in the form layer (uploader can type any number;
 * the form just stops calling the calc once override is on).
 */

export const DEFAULT_RENTAL_DEPOSIT_MONTHS = 2;
export const DEFAULT_UTILITIES_DEPOSIT_MONTHS = 0.5;
export const DEFAULT_ACCESS_CARD_DEPOSIT_PER_PCS = 100;

/**
 * WHICH rent a deposit is a multiple of — the single source of truth, shared by the
 * edit-unit display and the server-side deposit biller so the number an admin reads
 * can never differ from the number a tenant is billed.
 *
 * An OCCUPIED unit's deposit follows the TENANCY's negotiated rent, NOT the listing's
 * asking rate. Those are different numbers and the gap is unbounded: a unit advertised
 * at RM1,500 let to a tenant at RM5 was showing a RM3,000 rental deposit (2 × the asking
 * rate) beside a RM2.42 first-invoice card priced off the real RM5. Same screen, two
 * different rents, and the deposit was the wrong one.
 *
 * The asking rate remains the basis when there is NO tenancy — a vacant unit or the
 * create-unit form, where the advertised deposit is exactly what a prospect should see.
 *
 * Null-propagating like the calcs below: no tenancy rent AND no asking rate ⇒ null.
 */
export function resolveDepositBasisRate(input: {
  /** Tenancy.monthlyRentAmount for the ACTIVE tenancy, when the unit is occupied. */
  tenancyMonthlyRent: number | null | undefined;
  /** Listing.rentalRate — the advertised asking rate. */
  rentalRate: number | null | undefined;
}): number | null {
  // `!= null` (not a truthiness test): a legitimately-zero tenancy rent is a real,
  // deliberate figure — a rent-free period still has a deposit basis of 0, and must not
  // silently fall back to the asking rate and bill a deposit nobody agreed to.
  if (input.tenancyMonthlyRent != null) return input.tenancyMonthlyRent;
  return input.rentalRate ?? null;
}

export function computeRentalDepositMyr(input: {
  rentalRate: number | null | undefined;
  depositMonths: number | null | undefined;
}): number | null {
  if (input.rentalRate == null) return null;
  const months = input.depositMonths ?? DEFAULT_RENTAL_DEPOSIT_MONTHS;
  return input.rentalRate * months;
}

export function computeUtilitiesDepositMyr(input: {
  rentalRate: number | null | undefined;
  utilitiesDepositMonths: number | null | undefined;
}): number | null {
  if (input.rentalRate == null) return null;
  const months = input.utilitiesDepositMonths ?? DEFAULT_UTILITIES_DEPOSIT_MONTHS;
  return input.rentalRate * months;
}

export function computeAccessCardDepositMyr(input: {
  accessCardDepositPerPcs: number | null | undefined;
  accessCardQuantity: number | null | undefined;
}): number | null {
  if (input.accessCardQuantity == null) return null;
  const perPcs = input.accessCardDepositPerPcs ?? DEFAULT_ACCESS_CARD_DEPOSIT_PER_PCS;
  return perPcs * input.accessCardQuantity;
}
