import { useCallback, useState } from "react";
import { loadCellColours, saveCellColours, loadPref, savePref } from "@/lib/view-prefs";

// Bills & Expenses Grid — drag-select, Ctrl-fill, colour fill, hide-column
// (UI Task 4, spec R31 a/b/c/d). Namespaced under "bills-grid" like every
// other view-prefs consumer in this module.
const NS = "bills-grid";

/** One selected cell. `value` is the cell's current numeric reading (or
 * `null`/non-numeric for text cells) — used for `sum`, which is numeric-only. */
export interface SelectionCell {
  cellKey: string;
  columnId: string;
  value?: number | null;
}

/** A fill target identified by cell identity. `cellKey` is the write target —
 * an `apartmentId` for unit-grain cells or a `listingId` for tenant sub-row
 * cells (grid-table.tsx's two `CellKey` namespaces) — while `apartmentId` is
 * always the OWNING apartment, used to resolve lock state. Lock state
 * (`row.billedAt` / `entry.lockState`) exists ONLY per apartment, so
 * resolving locks by `cellKey` would silently pass every sub-row `listingId`
 * through unlocked, even when its owning apartment is billed. Its current
 * value is irrelevant; `fill` always writes `anchorValue`. */
export interface FillTargetCell {
  cellKey: string;
  apartmentId: string;
  columnId: string;
}

export interface FillWrite {
  cellKey: string;
  columnId: string;
  value: number;
}

/** A cell targeted for a colour swatch. `periodMonth` completes the
 * `${apartmentId}:${columnId}:${periodMonth}` key the colour map is keyed on
 * (view-prefs.ts CellColourMap). */
export interface ColourCell {
  cellKey: string;
  columnId: string;
  periodMonth: string;
}

/**
 * `useGridSelection()` → `{ range, count, sum, fill, selectCells, setColour,
 * hiddenColumns, hideColumn }`.
 * `selectCells` (P4 Task 6) is the keyboard/click Shift-range writer — and,
 * as of Task 4/5, the SOLE range-population path. The old accretive
 * `onPointerDown`/`onPointerMove`/`onPointerUp` drag methods (and the
 * `isSelecting` state they used) were removed in Task 5: `useMultiSelection`
 * is now the page's mouse-drag selection producer, feeding this hook's
 * `range` via `selectCells`. `fill` stays parked (still tested, no live
 * caller yet).
 */
/**
 * The column a stored preference may be hiding for a reason that no longer exists, and
 * the flag recording that we already said so once.
 *
 * From `bd80276a` (2026-07-27) until the 2026-08-14 bearer fix, AIR's Tenant column was
 * PERMANENTLY blank: its applicability keyed on the legacy `tenant_direct`, which the
 * Unit setting drawer could no longer write. Hiding a column that never shows anything is
 * a reasonable thing to have done — and `hiddenColumns` is per-user localStorage, so it
 * outlives the deploy that gives the column its meaning back.
 */
const RELOCATED_AIR_COLUMN = "airTenant";
const AIR_UNHIDE_DONE_KEY = "airTenantUnhideDone";

/**
 * PURE. The trust boundary for the stored hidden-columns preference.
 *
 * localStorage is user-controlled and `loadPref` CASTS its `JSON.parse` result without
 * validating it (view-prefs.ts) — its internal try/catch cannot help a caller, because a
 * shape mismatch only throws later, at the point of use. This value is read inside a
 * `useState` initializer, so an unchecked `.filter()`/`.includes()` on a non-array turns a
 * corrupt preference into a TypeError that white-screens the ENTIRE bills-grid page rather
 * than degrading one cell.
 *
 * Anything that is not a list of strings collapses to "nothing hidden" — the safe
 * direction: showing one column too many is undone in a click, whereas a hidden money
 * column is the exact failure the migration below exists to repair.
 *
 * Takes `unknown` deliberately. A `string[]` parameter would only move the lie one frame
 * up the stack, since no caller reading from storage can actually promise it.
 */
export function readHiddenColumns(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
}

/** PURE. Drops the relocated AIR column, leaving every other entry untouched. Separate
 *  from the shape check above because it must run ONCE, while validation runs on every
 *  read — folding them together would re-strip the column after a deliberate re-hide. */
export function unhideRelocatedAirColumn(stored: readonly string[]): string[] {
  return stored.filter((c) => c !== RELOCATED_AIR_COLUMN);
}

export function useGridSelection() {
  const [range, setRange] = useState<SelectionCell[]>([]);
  const [hiddenColumns, setHiddenColumnsState] = useState<string[]>(() => {
    // Sanitised on EVERY read, not just the migrating one — the steady-state path below
    // returns this value straight to the grid's column filter.
    const stored = readHiddenColumns(loadPref<unknown>(NS, "hiddenColumns", []));
    // ONE-TIME repair. Tenant-borne is the SEEDED DEFAULT for both listing modes, so
    // without this an admin who had hidden the blank column would open the grid to "—" in
    // the AIR Owner cell and NO cell anywhere to read or type the water bill into — the
    // money column simply absent, with nothing on screen explaining why.
    //
    // Deliberately not a permanent ban: the flag means an admin who hides the column again
    // afterwards keeps it hidden. Repairing state we broke is legitimate; overriding a
    // choice made with the column working would not be.
    if (loadPref<boolean>(NS, AIR_UNHIDE_DONE_KEY, false)) return stored;
    const next = unhideRelocatedAirColumn(stored);
    // ORDER MATTERS: repair first, flag only once the repair is readable back. `savePref`
    // swallows quota errors by design (view-prefs.ts) and this same namespace also stores
    // cellColours, which can fill it — flagging first would strand a profile in the exact
    // state this exists to undo: "already repaired" recorded, column still hidden, and the
    // one-shot migration never firing again.
    if (next.length !== stored.length) {
      savePref(NS, "hiddenColumns", next);
      const readBack = readHiddenColumns(loadPref<unknown>(NS, "hiddenColumns", []));
      if (readBack.includes(RELOCATED_AIR_COLUMN)) return next; // write lost — retry next mount
    }
    savePref(NS, AIR_UNHIDE_DONE_KEY, true);
    return next;
  });

  // (a) drag-select: count = all selected cells; sum = Σ of NUMERIC selected
  // cells only, rounded to 2dp.
  const count = range.length;
  const sum = Number(
    range
      .reduce((acc, c) => acc + (typeof c.value === "number" && Number.isFinite(c.value) ? c.value : 0), 0)
      .toFixed(2),
  );

  /**
   * P4 Task 6: imperatively REPLACE the selection with an explicit cell set —
   * the thin `setRange` wrapper the keyboard/click Shift-range path writes into.
   * `range` stays a `SelectionCell[]`, so the five existing consumers (count/sum
   * badge, colour-fill `range.map`, ctrl-fill `range[0]`/`slice(1)`,
   * `hasSelection`, `isCellSelected`) are untouched — this only adds a setter.
   * Callers pass a flattened rectangle (from `useGridNav.extendRange`) or a
   * single-cell array (a plain move → collapse, R7).
   */
  const selectCells = useCallback((cells: SelectionCell[]) => setRange(cells), []);

  /**
   * (b) Ctrl-fill. MONEY CONSTRAINT #1: a fill range that spans a locked/billed
   * row must silently EXCLUDE that row's cells from the write — a bulk fill
   * can never mutate locked money. `isRowLocked` is evaluated per target
   * cell's OWNING APARTMENT (never per `cellKey` — a sub-row `cellKey` is a
   * `listingId`, which never appears in any lock-state map, so resolving by
   * `cellKey` would defeat the guard for every per-room money cell) and
   * filtered out BEFORE the staged writes are returned. Fails CLOSED: a cell
   * is kept ONLY when `isRowLocked` returns exactly `false` (fail-closed) —
   * `true` excludes, and so does anything else (`undefined`, or a future
   * caller that returns a truthy value like an ISO `billedAt` string instead
   * of a boolean must NOT slip locked money through). The parameter is typed
   * `unknown` specifically so TypeScript can't paper over a non-boolean
   * return; only strict `=== false` equality is trusted.
   */
  const fill = useCallback(
    (
      anchorValue: number,
      targetCells: FillTargetCell[],
      isRowLocked: (apartmentId: string) => unknown,
    ): FillWrite[] =>
      targetCells
        .filter((c) => isRowLocked(c.apartmentId) === false)
        .map((c) => ({ cellKey: c.cellKey, columnId: c.columnId, value: anchorValue })),
    [],
  );

  /**
   * (c) Colour fill. MONEY CONSTRAINT #2: writes ONLY to localStorage via
   * `saveCellColours` — colour is cosmetic (view-prefs.ts), NEVER a `fetch`,
   * NEVER an API write, NEVER a calc input.
   */
  const setColour = useCallback((cells: ColourCell[], colour: string) => {
    const next = { ...loadCellColours(NS) };
    for (const c of cells) next[`${c.cellKey}:${c.columnId}:${c.periodMonth}`] = colour;
    saveCellColours(NS, next);
    return next;
  }, []);

  /**
   * (d) Hide/show a whole column (toggle by id). Pure view-state persisted via
   * `savePref` — a hidden column's staged edits stay in the buffer that lives
   * outside this hook (grid-table.tsx / ui-10's page shell); hiding is never a
   * mutation of that buffer.
   */
  const hideColumn = useCallback((id: string) => {
    setHiddenColumnsState((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      savePref(NS, "hiddenColumns", next);
      return next;
    });
  }, []);

  return { range, count, sum, fill, selectCells, setColour, hiddenColumns, hideColumn };
}
