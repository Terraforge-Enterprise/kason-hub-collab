// P4 (Excel MOUSE selection, V2) Task 2 — useMultiSelection, the selection
// PRODUCER hook. Holds two pieces of state:
//   - `committed`: SelectionCell[] — cells locked in by prior gestures
//     (ctrl-toggles + folded rects). Additive across gestures.
//   - `rect`: {anchor, focus} | null — the ONE currently-open drag/shift
//     rectangle, its two endpoints as stable CellRefs. `null` when no drag is
//     in flight.
// On EVERY gesture it recomputes
//   selectCells( dedupe( committed ∪ (rect ? rectBetween(rect.anchor, rect.focus) : []) ) )
// and drives `setActive` on the landing cell. Pure of DOM — it never reads the
// mouse, never touches the page; the pointer-DOM wiring (Task 4) calls these
// methods. NO money write: it only computes `sel.range` via `selectCells`;
// Delete/writes happen elsewhere (onDelete, unchanged).
//
// Gesture precedence is CTRL-before-SHIFT (a deliberate divergence): when a
// pointerdown carries both modifiers it takes the CTRL branch, so
// Ctrl+Shift-together behaves as Ctrl (toggle-add), never a shift-extend.
//
// State lives in refs, not useState: a gesture may mutate committed AND rect
// and must recompute the union from the POST-mutation values synchronously in
// the same call (a batched setState would recompute from stale values). Refs
// give us a synchronous read-after-write; `recompute()` reads the refs and
// fires the spies. No render depends on this state (the grid reads the
// selection from `sel.range`, which `selectCells` drives), so there is nothing
// to re-render here.
import { useCallback, useMemo, useRef } from "react";
import type { CellRef } from "./use-grid-nav";
import type { SelectionCell } from "./use-grid-selection";

export interface PointerMods {
  shift: boolean;
  ctrl: boolean; // ctrl = ctrlKey || metaKey (resolved by the DOM wiring in Task 4)
}

export interface MultiSelection {
  onCellPointerDown: (cell: CellRef, mods: PointerMods) => void;
  onCellPointerEnter: (cell: CellRef) => void; // drag-grow (only while a rect is open)
  onPointerUp: () => void; // finalize the current rect into committed
  collapseTo: (cell: CellRef | null) => void; // arrow/plain-move collapse → single cell or clear
  selectAll: (cells: SelectionCell[]) => void; // Ctrl/Cmd+A → replace selection with every navigable cell
  addCells: (cells: SelectionCell[]) => void; // Ctrl/Cmd+header → UNION cells into the committed selection
  reset: () => void;
}

interface Rect {
  anchor: CellRef;
  focus: CellRef;
}

const keyOf = (c: { cellKey: string; columnId: string }) => `${c.cellKey}:${c.columnId}`;

/** Dedupe by `${cellKey}:${columnId}`, keeping first-seen order. */
function dedupe(cells: SelectionCell[]): SelectionCell[] {
  const seen = new Set<string>();
  const out: SelectionCell[] = [];
  for (const c of cells) {
    const k = keyOf(c);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

const asCell = (r: CellRef): SelectionCell => ({ cellKey: r.cellKey, columnId: r.columnId });

export function useMultiSelection(args: {
  rectBetween: (a: CellRef, b: CellRef) => SelectionCell[];
  setActive: (cellKey: string, columnId: string) => void;
  selectCells: (cells: SelectionCell[]) => void;
}): MultiSelection {
  const { rectBetween, setActive, selectCells } = args;
  const committedRef = useRef<SelectionCell[]>([]);
  const rectRef = useRef<Rect | null>(null);

  // Recompute the union from the CURRENT refs and hand it to selectCells. Called
  // synchronously at the end of every gesture, after the refs are mutated.
  const recompute = useCallback(() => {
    const rect = rectRef.current;
    const rectCells = rect ? rectBetween(rect.anchor, rect.focus) : [];
    selectCells(dedupe([...committedRef.current, ...rectCells]));
  }, [rectBetween, selectCells]);

  // Fold the current open rect's flattened cells into committed (deduped), then
  // clear the rect. Shared by ctrl-down (fold-then-toggle) and pointerup.
  const foldRectIntoCommitted = useCallback(() => {
    const rect = rectRef.current;
    if (rect) {
      const rectCells = rectBetween(rect.anchor, rect.focus);
      committedRef.current = dedupe([...committedRef.current, ...rectCells]);
      rectRef.current = null;
    }
  }, [rectBetween]);

  const onCellPointerDown = useCallback(
    (cell: CellRef, mods: PointerMods) => {
      // CTRL checked BEFORE shift (deliberate: ctrl+shift-together → ctrl).
      if (mods.ctrl) {
        // Fold the open rect into committed, then TOGGLE this cell in committed
        // (remove if already present by cellKey+columnId, else add).
        foldRectIntoCommitted();
        const k = keyOf(cell);
        const present = committedRef.current.some((c) => keyOf(c) === k);
        committedRef.current = present
          ? committedRef.current.filter((c) => keyOf(c) !== k)
          : [...committedRef.current, asCell(cell)];
        // On an ADD, open a fresh single-cell rect at this cell (so a subsequent
        // ctrl+drag grows a NEW rectangle from here). On a REMOVE, DON'T open a
        // rect at the removed cell — a rect anchored there would re-materialize
        // it in the union via `rectBetween` and defeat the toggle-off (the cell
        // would visibly stay selected). Removal collapses the open rect to null.
        rectRef.current = present ? null : { anchor: cell, focus: cell };
        setActive(cell.cellKey, cell.columnId);
        recompute();
        return;
      }
      if (mods.shift) {
        // Extend the open rect's focus from its existing anchor; if no rect is
        // open, anchor at this cell. committed is untouched.
        const cur = rectRef.current;
        rectRef.current = cur ? { anchor: cur.anchor, focus: cell } : { anchor: cell, focus: cell };
        setActive(cell.cellKey, cell.columnId);
        recompute();
        return;
      }
      // Plain: clear committed, open a single-cell rect, activate.
      committedRef.current = [];
      rectRef.current = { anchor: cell, focus: cell };
      setActive(cell.cellKey, cell.columnId);
      recompute();
    },
    [foldRectIntoCommitted, recompute, setActive],
  );

  const onCellPointerEnter = useCallback(
    (cell: CellRef) => {
      // Drag-grow: only meaningful while a rect is open. No-op otherwise.
      if (!rectRef.current) return;
      rectRef.current = { anchor: rectRef.current.anchor, focus: cell };
      recompute();
    },
    [recompute],
  );

  const onPointerUp = useCallback(() => {
    // Finalize the current rect into committed. Union stays correct because the
    // folded cells were already in `committed ∪ rect`; after the fold `rect` is
    // null and the same cells live in `committed`.
    foldRectIntoCommitted();
    recompute();
  }, [foldRectIntoCommitted, recompute]);

  const collapseTo = useCallback(
    (cell: CellRef | null) => {
      committedRef.current = [];
      rectRef.current = cell ? { anchor: cell, focus: cell } : null;
      // Collapse writes the single cell (or clears) directly — not via the
      // rectBetween union — so an arrow/plain-move lands on exactly one cell.
      selectCells(cell ? [asCell(cell)] : []);
    },
    [selectCells],
  );

  // Ctrl/Cmd+A: REPLACE the whole selection with an explicit cell set (every
  // navigable cell). Sets committed to the (deduped) set and clears the open
  // rect, so the next gesture recomputes from a clean, fully-committed union —
  // never re-materialising a stale rect on top of select-all.
  const selectAll = useCallback((cells: SelectionCell[]) => {
    committedRef.current = dedupe(cells);
    rectRef.current = null;
    recompute();
  }, [recompute]);

  // Ctrl/Cmd + column-header: UNION the given cells into committed (folding any
  // open rect first), so an added column joins a non-contiguous selection
  // instead of replacing it. Deduped, so re-adding an already-present column is
  // idempotent (never grows the union with duplicates).
  const addCells = useCallback((cells: SelectionCell[]) => {
    foldRectIntoCommitted();
    committedRef.current = dedupe([...committedRef.current, ...cells]);
    rectRef.current = null;
    recompute();
  }, [foldRectIntoCommitted, recompute]);

  const reset = useCallback(() => {
    committedRef.current = [];
    rectRef.current = null;
  }, []);

  return useMemo(
    () => ({ onCellPointerDown, onCellPointerEnter, onPointerUp, collapseTo, selectAll, addCells, reset }),
    [onCellPointerDown, onCellPointerEnter, onPointerUp, collapseTo, selectAll, addCells, reset],
  );
}
