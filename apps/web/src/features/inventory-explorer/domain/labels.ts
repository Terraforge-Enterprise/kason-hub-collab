/**
 * User-facing labels for inventory-explorer enum values.
 *
 * Furnishing values are stored as snake_case slugs (`fully_furnished`,
 * `partial`, `unfurnished`) — matches `FURNISHING_OPTIONS` in
 * portal/pipeline/rental-entry-drawer/listing-section.tsx. Both `partial`
 * and `partially_furnished` map to the same label since seed data has
 * been observed in both shapes. Unknown furnishing values fall back to
 * `humanize()` so enum drift renders something readable.
 *
 * Facing values are stored as the cardinal/intercardinal abbreviation
 * (`"N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW"`) — see
 * `use-filter-cardinality.ts`. Unknown facing values fall back to the
 * raw string (we do NOT humanize a facing — it's an abbreviation, not
 * a slug).
 */

const FURNISHING_LABELS: Record<string, string> = {
  fully_furnished: "Fully furnished",
  partial: "Partially furnished",
  partially_furnished: "Partially furnished",
  unfurnished: "Unfurnished",
};

export function furnishingLabel(value: string): string {
  return FURNISHING_LABELS[value] ?? humanize(value);
}

const FACING_LABELS: Record<string, string> = {
  N: "North",
  S: "South",
  E: "East",
  W: "West",
  NE: "Northeast",
  NW: "Northwest",
  SE: "Southeast",
  SW: "Southwest",
};

export function facingLabel(value: string): string {
  return FACING_LABELS[value] ?? value;
}

/**
 * Convert a snake_case or kebab-case slug to Title Case, lowercasing
 * interior letters. Used as a fallback for unknown enum values so we
 * render something readable instead of leaking raw slugs to the UI.
 *
 *   humanize("hello_world")  → "Hello World"
 *   humanize("hello-world")  → "Hello World"
 *   humanize("HELLO_WORLD")  → "Hello World"
 */
export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
