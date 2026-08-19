// Render a room/apartment by its human label (frontend §16). The meter list
// endpoints now return apartmentUnitCode (+ listingType for rooms), so the UI
// shows "A-08-02 · master" instead of a truncated UUID. The fallback to a
// sliced id is paired with a DEV warning so a future API-contract regression
// (label stops arriving) surfaces loudly instead of silently showing a UUID.
export function unitLabel(
  row: { apartmentUnitCode?: string | null; listingType?: string | null },
  fallbackId?: string,
): string {
  if (row.apartmentUnitCode) {
    return row.listingType ? `${row.apartmentUnitCode} · ${row.listingType}` : row.apartmentUnitCode;
  }
  if (import.meta.env.DEV && fallbackId) {
    console.warn(`[meter] missing apartmentUnitCode — showing truncated id ${fallbackId}. API include regression?`);
  }
  return fallbackId ? fallbackId.slice(0, 8) : "—";
}
