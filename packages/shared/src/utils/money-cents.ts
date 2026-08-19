// packages/shared/src/utils/money-cents.ts
//
// The single source of truth for the integer-cent money primitive used across
// the finance code. Money strings are parsed to cents by EXACT decimal-string
// splitting (never parseFloat, which drifts), and rendered back to a 2dp string.
// Rounding everywhere downstream is `Math.round` on a non-negative magnitude —
// i.e. round-half-up — so this primitive deliberately carries no rounding of its
// own: it only does exact ×100 / ÷100 conversion and rejects > 2 decimal places.
//
// Both `prorateAmount` (utils/prorate.ts) and `computeManagementFee`
// (finance/owner-billing-fee.ts) build on these, and the signed
// net-remittance / statement totals in B2/B3 will reuse them too — so the
// half-up-on-magnitude contract lives here in exactly one place.

/**
 * Exact decimal-string (or number) → integer cents. Rejects anything that is
 * not an amount (optionally negative) with at most 2 decimal places.
 *
 * Negative amounts are accepted (e.g. "-60.00" → -6000) — a SUPERSET of the
 * original non-negative-only contract: every previously-valid input still
 * parses identically, this only additionally accepts a leading "-". Needed
 * because a BillingDocumentLine can carry a genuinely negative amount (an
 * owner-funded subsidy offset shown as a negative line on the tenant
 * invoice, agency-billing-itemization spec R2/R5) and `issueDocumentTx` runs
 * every line through this primitive. Symmetric with `centsToString`, which
 * already preserved a leading "-" on the way back out.
 *
 * The sign is peeled BEFORE splitting whole/frac (not applied to the whole
 * part alone) — `Number("-60") * 100 + Number("01")` would wrongly compute
 * -5999 for "-60.01" (adding the fractional cents' magnitude instead of
 * subtracting it), so the magnitude is parsed unsigned and the sign applied
 * once to the combined total. A magnitude of exactly 0 (e.g. "-0.00") always
 * returns +0, never -0 (Object.is/toBe-sensitive downstream comparisons must
 * never see a signed zero).
 *
 * @param amount the money value, e.g. "200.16", 200.16, or "-60.00"
 * @param label  caller name used to prefix the error message (e.g. "prorateAmount")
 */
export function toCents(amount: string | number, label = "toCents"): number {
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`${label}: invalid money amount "${amount}" (max 2 decimal places)`);
  }
  const negative = s.startsWith("-");
  const magnitude = negative ? s.slice(1) : s;
  const [whole, frac = ""] = magnitude.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  return negative && cents !== 0 ? -cents : cents;
}

/** Integer cents → 2dp string. Preserves a leading "-" for negative cents. */
export function centsToString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
