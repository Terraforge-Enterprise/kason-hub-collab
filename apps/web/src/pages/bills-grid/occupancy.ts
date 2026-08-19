import type { GridRow, GridSubRow } from "@/api/bills-grid";

/** A unit is OCCUPIED iff at least one of its rooms has an active tenancy.
 * Defensive on `subRows` (`?? []`) — this runs at the PAGE level, outside
 * GridErrorBoundary (mirrors bills-grid-page.tsx's `listingToApartment`
 * comment): a malformed row must never crash the page before GridTable's own
 * boundary gets a chance to catch it. */
export function isOccupied(row: GridRow): boolean {
  return (row.subRows ?? []).some((sr) => sr.tenancyId != null);
}

/**
 * Occupied-first (stable) ordering. When `showVacant` is false, fully-vacant
 * units are hidden — EXCEPT a vacant unit that still carries saved billing data
 * (`entry != null`), which stays visible so owner charges on a vacant unit are
 * never silently hidden (money-safety).
 */
export function visibleUnits(rows: GridRow[], showVacant: boolean): GridRow[] {
  const shown = showVacant ? rows : rows.filter((r) => isOccupied(r) || r.entry != null);
  return [...shown.filter(isOccupied), ...shown.filter((r) => !isOccupied(r))];
}

/**
 * A vacant partition ROOM (no active tenancy) carries no tenant to bill, so it
 * only clutters the grid — hide it when `showVacant` is off. This is the room-grain
 * analog of `visibleUnits`' unit-level filter. A vacant room is KEPT (money-safety,
 * mirroring the `entry != null` carve-out above) when it still holds period billing
 * data — an orphan meter reading from a departed tenant or an entered amount — so a
 * pending charge is never silently hidden. Occupied rooms always show. With
 * `showVacant` on, every room shows (parity).
 */
export function visibleSubRows(subRows: GridSubRow[], showVacant: boolean): GridSubRow[] {
  if (showVacant) return subRows;
  return subRows.filter(
    (sr) => sr.tenancyId != null || sr.currentKwh != null || sr.previousKwh != null || sr.amount != null,
  );
}
