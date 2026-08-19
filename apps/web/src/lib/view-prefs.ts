// Generic namespaced localStorage view-state. Generalises the pattern in
// pages/tenancy/tenant-tracker/prefs.ts, which is hard-coded to two
// tenant-tracker keys and has no hide-COLUMN or colour storage.
//
// COLOUR FILL IS COSMETIC. It is never sent to the API, never stored in any
// grid table, and never a calc input. Payment tracking is the typed
// `paymentStatus` field. Losing these colours changes no money.
const k = (ns: string, key: string) => `${ns}:${key}`;

export function loadPref<T>(ns: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k(ns, key));
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref<T>(ns: string, key: string, value: T): void {
  try { localStorage.setItem(k(ns, key), JSON.stringify(value)); } catch { /* private mode / quota — degrade silently */ }
}

/** Key format: `${apartmentId}:${columnId}:${periodMonth}` → CSS colour. */
export type CellColourMap = Record<string, string>;

export function loadCellColours(ns: string): CellColourMap {
  return loadPref<CellColourMap>(ns, "cellColours", {});
}

const MAX_COLOURED_CELLS = 5000; // ~5 MB quota guard across 165 units × 12 months

export function saveCellColours(ns: string, map: CellColourMap): void {
  let toStore = map;
  const keys = Object.keys(map);
  if (keys.length > MAX_COLOURED_CELLS) {
    // Evict oldest period first — the key's third segment is the periodMonth.
    const sorted = keys.sort((a, b) => (a.split(":")[2] ?? "").localeCompare(b.split(":")[2] ?? ""));
    toStore = Object.fromEntries(sorted.slice(keys.length - MAX_COLOURED_CELLS).map((key) => [key, map[key]]));
  }
  savePref(ns, "cellColours", toStore);
}
