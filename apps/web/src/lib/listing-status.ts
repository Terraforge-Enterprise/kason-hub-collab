// Single source of truth for the (occupancyStatus, listingStatus,
// visibilityMode, readyNow) → human-label mapping. Lives under /lib so
// both admin (`apps/web/src/pages/inventory/...`) and portal
// (`apps/web/src/pages/portal/...`) can import it without dragging in
// either page tree's component graph.
//
// Renamed from `unit-status.ts` in the three-table refactor (2026-05-19).
// The shape now describes a Listing (not the old conflated Unit). The
// `readyNow` field is computed server-side from
// (propertyStatus, listingStatus, visibilityMode, occupancyStatus); the
// SPA consumes the column verbatim — no client-side derivation here.

export type ListingLifecycle = {
  occupancyStatus: string;
  listingStatus: string;
  // The schema's Listing-level visibility column: PUBLIC ↔ "published",
  // RESTRICTED ↔ "private". Older callers may still pass the
  // publishStatus enum vocabulary; both are tolerated.
  visibilityMode?: "PUBLIC" | "RESTRICTED" | string;
  readyNow: boolean;
};

/** @deprecated Use `ListingLifecycle`. Kept for back-compat. */
export type UnitLifecycle = ListingLifecycle;

const OCCUPANCY_LABEL: Record<string, string> = {
  vacant: "Vacant",
  occupied: "Occupied",
  reserved: "Reserved",
  maintenance: "Maintenance",
};

// The "archived" enum value is the internal name; surfaced as "Deactivated"
// in every UI. The intent-conveying label clarifies the admin took an
// explicit action; the row is reversible via Reactivate.
const LISTING_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Deactivated",
  // Legacy data may carry "published" in listingStatus; render gracefully.
  published: "Active",
};

// Canonical sort order for status displays (dropdowns, filters, status
// columns): Active first → Draft → Deactivated last. Use this when you
// need to order options/rows by status priority.
export const LISTING_STATUS_ORDER: readonly string[] = [
  "active",
  "draft",
  "archived",
];

export function sortByListingStatus<T extends { listingStatus: string }>(
  rows: T[],
): T[] {
  const rank = (s: string) => {
    const i = LISTING_STATUS_ORDER.indexOf(s);
    return i === -1 ? LISTING_STATUS_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a.listingStatus) - rank(b.listingStatus));
}

export function occupancyLabel(s: string): string {
  return OCCUPANCY_LABEL[s] ?? s;
}

export function listingLabel(s: string): string {
  return LISTING_LABEL[s] ?? s;
}

/**
 * Composite human label for the table-row's status column. "Ready Now"
 * wins when the unit is bookable; otherwise show occupancy + a hint
 * about why it isn't ready (draft / private / deactivated).
 */
export function compositeStatusLabel(u: ListingLifecycle): string {
  if (u.listingStatus === "archived") {
    return `${occupancyLabel(u.occupancyStatus)} · Deactivated`;
  }
  if (u.readyNow) return "Ready Now";
  if (u.listingStatus === "draft") return `${occupancyLabel(u.occupancyStatus)} · Draft`;
  if (u.visibilityMode === "RESTRICTED") {
    return `${occupancyLabel(u.occupancyStatus)} · Private`;
  }
  return occupancyLabel(u.occupancyStatus);
}

/**
 * Listed count: how many units in a property are listed.
 * A unit counts iff (listingStatus="active" AND occupancyStatus="vacant").
 *
 * Visibility mode is intentionally NOT part of this gate — RESTRICTED
 * units still count as listed; the per-agent visibility layer (grants /
 * hide-list) only affects which agents see which units, not whether the
 * unit is "listed" at the property level.
 */
export function isListedToAgents(u: {
  listingStatus: string;
  occupancyStatus: string;
}): boolean {
  return u.listingStatus === "active" && u.occupancyStatus === "vacant";
}
