export const TICKET_CATEGORIES = [
  "Plumbing", "Lighting", "Electrical", "Aircond/HVAC", "Appliance",
  "Furniture/Fittings", "Wifi/Internet", "Pest", "Cleaning",
  "Locks/Access", "Structural", "Painting", "Other",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const OTHER_CATEGORY = "Other" as const;

/**
 * Case-insensitive exact match against TICKET_CATEGORIES. Non-matches (incl.
 * empty/null) -> { canonical: "Other", isMapped: false }. Single source of truth
 * for both the combobox display and the analytics aggregation (Spec 2A §5).
 */
export function normalizeCategory(
  raw: string | null | undefined,
): { canonical: string; isMapped: boolean } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { canonical: OTHER_CATEGORY, isMapped: false };
  const match = TICKET_CATEGORIES.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match ? { canonical: match, isMapped: true } : { canonical: OTHER_CATEGORY, isMapped: false };
}

/**
 * Like {@link normalizeCategory} but matches against a caller-supplied list of
 * category names (the org's admin-managed WorkCategory names) instead of the
 * frozen TICKET_CATEGORIES list. Used by Unit Analytics so custom/renamed
 * categories count under their own name instead of collapsing into "Other".
 * The literal OTHER_CATEGORY is always treated as an intentional, mapped bucket
 * (parity with normalizeCategory). Empty/null, or any value not in `names`,
 * resolves to unmapped "Other".
 */
export function normalizeCategoryAgainst(
  raw: string | null | undefined,
  names: readonly string[],
): { canonical: string; isMapped: boolean } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { canonical: OTHER_CATEGORY, isMapped: false };
  if (trimmed.toLowerCase() === OTHER_CATEGORY.toLowerCase()) {
    return { canonical: OTHER_CATEGORY, isMapped: true };
  }
  const match = names.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match ? { canonical: match, isMapped: true } : { canonical: OTHER_CATEGORY, isMapped: false };
}
