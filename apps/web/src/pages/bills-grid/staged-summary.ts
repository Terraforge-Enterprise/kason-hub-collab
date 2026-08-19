import type { GridRow } from "@/api/bills-grid";
import { CURRENT_COLUMNS, type ColumnId } from "./columns";

/** One staged (unsaved) edit belonging to a unit, resolved for the Confirm-save
 * preview: which cell, its human label, and the value that will be written. */
export interface UnitCellEdit {
  /** The staged key's cellKey — an apartmentId (unit-grain) or a listingId
   * (sub-row/meter). Paired with `columnId` it is the exact `unstage(...)` key. */
  cellKey: string;
  columnId: ColumnId;
  /** Human-readable column label ("TNB Owner", "Current Meter (kwh) — Ali"). */
  label: string;
  /** The staged raw text, trimmed. "" means the cell was CLEARED (blanked). */
  value: string;
  /**
   * Set ONLY when `translateStaged` will drop this cell (bills-grid-page.tsx).
   *
   * The preview MUST say so. Listing it as a pending write and then reporting "Saved."
   * while the buffer is wiped loses the amount with no signal anywhere — strictly worse
   * than the invisible write the drop was added to prevent. Same reasoning as
   * `unresolved` below, one grain finer. Absent, never `false`, so existing exact-shape
   * assertions stay valid.
   */
  skipped?: true;
  /**
   * WHY it will be dropped, so the preview can explain itself instead of guessing.
   * Present exactly when `skipped` is.
   *
   * • `"bearer"` — the cell sits on a bearer side the unit's current setting no longer
   *   bills. Reachable whenever a bearer changes AFTER something was typed: the
   *   owner|tenant pairs collapse to one wire field, the Unit setting drawer refetches
   *   the grid but has no handle on the staged buffer, and the buffer is keyed by column
   *   rather than by wire field.
   * • `"locked"` — the cell's own settlement bucket carries money. Reachable when a
   *   payment lands after the value was typed, or a sessionStorage buffer is restored
   *   across one.
   *
   * They are NOT interchangeable copy. Telling an admin "setting changed" about money
   * that has simply been paid sends them to the Unit settings drawer to fix a setting
   * that was never wrong.
   */
  skipReason?: SaveSkipReason;
}

/** Why Save will drop a staged cell. See {@link UnitCellEdit.skipReason}. */
export type SaveSkipReason = "bearer" | "locked";

export interface UnitEditSummary {
  unitCode: string;
  /** Owning apartment — the grain the per-unit Clear button unstages against. */
  apartmentId: string;
  cellCount: number;
  /** The individual staged edits, ordered by grid column. */
  cells: UnitCellEdit[];
  /** Set ONLY when `apartmentId` matches no row: the staged buffer lives in
   * sessionStorage and is restored verbatim, so it outlives the units it
   * references (a unit deleted by someone else, a DB reset, a restored
   * crash-recovery snapshot). Such an edit CANNOT be saved — handleSave drops
   * it — so the preview must say so rather than render `unitCode` (which is
   * the bare id here) as though it were a real unit. Absent, never `false`,
   * so existing exact-shape assertions stay valid. */
  unresolved?: true;
}

// columnId → "Band Header" (e.g. "TNB Owner"); bandless columns keep the bare
// header. Built once from the frozen column contract so the preview label can
// never drift from what the grid actually shows.
const LABEL_BY_COLUMN: Record<string, string> = Object.fromEntries(
  CURRENT_COLUMNS.map((c) => [c.id, c.band ? `${c.band} ${c.header}` : c.header]),
);
// Column display order, for stable ordering of a unit's listed cells.
const COLUMN_ORDER: Record<string, number> = Object.fromEntries(
  CURRENT_COLUMNS.map((c, i) => [c.id, i]),
);

/** Group staged `${cellKey}:${columnId}` edits by owning unit. A unit-grain
 * cellKey IS an apartmentId; a sub-row cellKey is a listingId, resolved to its
 * apartment. Mirrors the page's splitStagedKey + listingToApartment.
 *
 * `excludeApartmentIds`, when passed, mirrors handleSave's own
 * `billedApartmentIds` exclusion — a staged cell owned by an excluded
 * apartment is skipped entirely so the summary never lists a unit
 * handleSave will not actually write. Callers should pass `rows` as the
 * SAME row set handleSave resolves apartments against (lastGood.rows, not
 * a filtered/visible subset) so a staged-but-filtered-out unit still
 * resolves its real unitCode instead of falling back to a raw id. */
export function summarizeStagedByUnit(
  staged: Record<string, string>,
  rows: GridRow[],
  excludeApartmentIds?: ReadonlySet<string>,
  /** "handleSave will NOT write this cell, and why." Returns null when the cell WILL be
   *  written. Omitted ⇒ nothing is flagged, which keeps every pre-existing caller and
   *  fixture behaving exactly as before. */
  cellSkipReason?: (cellKey: string, columnId: ColumnId) => SaveSkipReason | null,
): UnitEditSummary[] {
  const aptByListing = new Map<string, string>();
  const unitCodeByApt = new Map<string, string>();
  const partyByListing = new Map<string, string | null>();
  for (const r of rows) {
    unitCodeByApt.set(r.apartmentId, r.unitCode);
    // Defensive, mirrors the page's own listingToApartment (`row.subRows ??
    // []`) — a malformed `subRows` here must never throw; that's exactly the
    // contract GridErrorBoundary exists to catch one layer further in.
    for (const sr of r.subRows ?? []) {
      aptByListing.set(sr.listingId, r.apartmentId);
      partyByListing.set(sr.listingId, sr.partyName);
    }
  }

  // apartmentId → its accumulating edit list (insertion order = discovery order,
  // re-sorted by column below).
  const cellsByApt = new Map<string, UnitCellEdit[]>();
  for (const key of Object.keys(staged)) {
    const idx = key.lastIndexOf(":"); // split on the LAST colon — cellKey is an id, columnId never has one
    const cellKey = key.slice(0, idx);
    const columnId = key.slice(idx + 1) as ColumnId;
    const apt = aptByListing.get(cellKey) ?? cellKey; // unit-grain cellKey IS the apartmentId
    if (excludeApartmentIds?.has(apt)) continue;

    // For a sub-row (meter) cell, disambiguate with the room's tenant name —
    // a partitioned unit can have the same column edited on two rooms.
    const base = LABEL_BY_COLUMN[columnId] ?? columnId;
    const party = partyByListing.get(cellKey);
    const label = party ? `${base} — ${party}` : base;

    // INJECTED by the page, built from the SAME rule translateStaged applies, so the
    // preview can never promise a write the save then drops. A parameter rather than a
    // local computation on purpose: this module groups and labels, and reaching into
    // bearer config here would couple a pure formatter to the whole GridRow shape.
    const skipReason = cellSkipReason?.(cellKey, columnId) ?? null;

    const list = cellsByApt.get(apt) ?? [];
    list.push({
      cellKey, columnId, label, value: (staged[key] ?? "").trim(),
      ...(skipReason ? { skipped: true as const, skipReason } : {}),
    });
    cellsByApt.set(apt, list);
  }

  // Safety valve: with NO rows we cannot tell "stale" from "not loaded yet"
  // (initial fetch in flight, or a failed fetch leaving lastGood empty).
  // Flagging everything would tell the user their real unsaved work is dead, so
  // when there is nothing to resolve against, nothing is flagged.
  const canResolve = unitCodeByApt.size > 0;

  return [...cellsByApt.entries()]
    .map(([apt, cells]) => {
      const unitCode = unitCodeByApt.get(apt);
      return {
        unitCode: unitCode ?? apt,
        apartmentId: apt,
        cellCount: cells.length,
        cells: cells.sort((a, b) => (COLUMN_ORDER[a.columnId] ?? 0) - (COLUMN_ORDER[b.columnId] ?? 0)),
        ...(canResolve && unitCode === undefined ? { unresolved: true as const } : {}),
      };
    })
    .sort((a, b) => a.unitCode.localeCompare(b.unitCode));
}
