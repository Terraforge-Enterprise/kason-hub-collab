// P4 Task 2 — useGridNav. Active-cell state + column-preserving arrow moves +
// period reset (R14). Pure nav state: NO money write, NO DOM. Consumes
// buildNavRows (Task 1) as the single source of truth for navigable cells.
//
// The active position is stored as an internal {cellKey, columnId} coordinate
// (Task 6 Fix 2 — was {rowIndex, columnId}). Keying on the STABLE cellKey makes
// the active cell robust to navRows RE-DERIVATION: a show-vacant toggle /
// column-filter / background refetch reorders `orderedRows` → `navRows`
// re-derives → the SAME rowIndex would resolve to a DIFFERENT cell. Keyed on
// rowIndex, `active` silently pointed at the wrong cell (Esc then reverted the
// wrong cell / commit moved from the wrong origin). Keyed on cellKey, `active`
// re-resolves to its own cell after any reorder, or clears cleanly to null if
// that cell has left the grid — never a stray neighbour. rowIndex is still the
// nav coordinate for MOVEMENT (it counts ONLY navigable rows, prior-month
// strips skipped), re-resolved from cellKey on demand via `resolvePos`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GridRow } from "@/api/bills-grid";
import type { ColumnId, GridColumn } from "./columns";
import { buildNavRows, type NavCell, type NavRow } from "./nav-cells";
import type { SelectionCell } from "./use-grid-selection";

export type Dir = "up" | "down" | "left" | "right";
export interface ActiveCell { cellKey: string; columnId: ColumnId; apartmentId: string; editable: boolean; }
/** The internal active/anchor coordinate — a STABLE cell identity, re-resolved
 * to a rowIndex against the current navRows on demand (Task 6 Fix 2). */
interface CellPos { cellKey: string; columnId: ColumnId; }
/** A stable cell identity for `rectBetween` endpoints (mouse selection, Task 1).
 * Same shape as the internal `CellPos`, but PUBLIC — the mouse-selection layer
 * (Task 2+) passes two of these to flatten the drag rectangle. */
export interface CellRef { cellKey: string; columnId: ColumnId; }
export interface GridNav {
  active: ActiveCell | null;
  navRows: NavRow[];
  isActive: (cellKey: string, columnId: ColumnId) => boolean;
  setActiveByCell: (cellKey: string, columnId: ColumnId) => void; // pointer click → activate
  move: (dir: Dir) => void;                // arrow nav (plain move collapses any Shift-range anchor, R7)
  extendRange: (dir: Dir) => SelectionCell[]; // Shift+arrow → rectangle anchor→focus (Task 6)
  rectBetween: (a: CellRef, b: CellRef) => SelectionCell[]; // mouse drag → rectangle a→b (Task 1)
  activeNavCell: () => NavCell | null;     // resolve the current NavCell (cellKey/columnId)
  reset: () => void;
}

export function useGridNav(args: { rows: GridRow[]; columns: GridColumn[]; currentPeriod: string }): GridNav {
  const navRows = useMemo(() => buildNavRows(args.rows, args.columns), [args.rows, args.columns]);
  const [pos, setPos] = useState<CellPos | null>(null);
  // Shift-range anchor (Task 6): the active cell captured when Shift was first
  // held. A plain move/click CLEARS it (collapse, R7); the next Shift+arrow
  // re-anchors at the then-current active cell.
  const [anchor, setAnchor] = useState<CellPos | null>(null);

  // Period reset (R14): drop the active cell (and any range anchor) on period change.
  const periodRef = useRef(args.currentPeriod);
  useEffect(() => {
    if (periodRef.current !== args.currentPeriod) {
      periodRef.current = args.currentPeriod;
      setPos(null);
      setAnchor(null);
    }
  }, [args.currentPeriod]);

  // Resolve a stable {cellKey, columnId} to its current {rowIndex, NavCell} in
  // navRows, or null if it no longer exists (row filtered out / cell no longer
  // navigable). This is the Fix-2 re-resolution point.
  const resolvePos = useCallback(
    (p: CellPos | null): { rowIndex: number; cell: NavCell } | null => {
      if (!p) return null;
      for (const r of navRows) {
        const c = r.cells.find((x) => x.cellKey === p.cellKey && x.columnId === p.columnId);
        if (c) return { rowIndex: c.rowIndex, cell: c };
      }
      return null;
    },
    [navRows],
  );

  const cellAt = useCallback(
    (rowIndex: number, columnId: ColumnId): NavCell | null =>
      navRows[rowIndex]?.cells.find((c) => c.columnId === columnId) ?? null,
    [navRows],
  );

  const active: ActiveCell | null = useMemo(() => {
    const r = resolvePos(pos);
    if (!r) return null;
    const c = r.cell;
    return { cellKey: c.cellKey, columnId: c.columnId, apartmentId: c.apartmentId, editable: c.editable };
  }, [pos, resolvePos]);

  const setActiveByCell = useCallback((cellKey: string, columnId: ColumnId) => {
    for (const r of navRows) {
      const c = r.cells.find((x) => x.cellKey === cellKey && x.columnId === columnId);
      if (c) { setPos({ cellKey, columnId }); setAnchor(null); return; } // click collapses any range
    }
  }, [navRows]);

  // Compute the next focus cell from a resolved {rowIndex, columnId} — the pure
  // step logic shared by `move` and `extendRange`. Returns the target NavCell
  // (as a CellPos), or `cur` unchanged at an edge.
  const stepFrom = useCallback(
    (curRowIndex: number, columnId: ColumnId, dir: Dir): CellPos | null => {
      if (dir === "left" || dir === "right") {
        const row = navRows[curRowIndex]; if (!row) return null;
        const i = row.cells.findIndex((c) => c.columnId === columnId); if (i < 0) return null;
        const j = dir === "right" ? i + 1 : i - 1;
        return j >= 0 && j < row.cells.length
          ? { cellKey: row.cells[j].cellKey, columnId: row.cells[j].columnId }
          : null; // edge-stop
      }
      // up/down: nearest row (in the given direction) with a cell in the SAME column.
      const step = dir === "down" ? 1 : -1;
      for (let ri = curRowIndex + step; ri >= 0 && ri < navRows.length; ri += step) {
        const c = navRows[ri].cells.find((x) => x.columnId === columnId);
        if (c) return { cellKey: c.cellKey, columnId };
      }
      return null; // edge-stop
    },
    [navRows],
  );

  const move = useCallback((dir: Dir) => {
    setAnchor(null); // plain move collapses any Shift-range anchor (R7)
    setPos((cur) => {
      // Default the active cell to the first navigable cell if none yet.
      const resolved = resolvePos(cur);
      if (!resolved) {
        const first = navRows.find((r) => r.cells.length)?.cells[0];
        return first ? { cellKey: first.cellKey, columnId: first.columnId } : cur;
      }
      return stepFrom(resolved.rowIndex, resolved.cell.columnId, dir) ?? cur;
    });
  }, [navRows, resolvePos, stepFrom]);

  // Flatten the rowIndex-span × columnId-span rectangle between two resolved
  // corners into SelectionCell[] (structural blanks omitted, read-only kept).
  const rectangle = useCallback(
    (
      a: { rowIndex: number; cell: NavCell },
      b: { rowIndex: number; cell: NavCell },
    ): SelectionCell[] => {
      const colOrder = args.columns.map((c) => c.id);
      const ai = colOrder.indexOf(a.cell.columnId);
      const bi = colOrder.indexOf(b.cell.columnId);
      const colLo = Math.min(ai, bi), colHi = Math.max(ai, bi);
      const rowLo = Math.min(a.rowIndex, b.rowIndex), rowHi = Math.max(a.rowIndex, b.rowIndex);
      const out: SelectionCell[] = [];
      for (let ri = rowLo; ri <= rowHi; ri += 1) {
        for (let ci = colLo; ci <= colHi; ci += 1) {
          const c = cellAt(ri, colOrder[ci]);
          if (c) out.push({ cellKey: c.cellKey, columnId: c.columnId });
        }
      }
      return out;
    },
    [args.columns, cellAt],
  );

  /**
   * Task 6 — Shift+arrow range extension. On the FIRST shift-step the current
   * active cell becomes the anchor; every subsequent shift-step advances the
   * focus and re-computes the RECTANGLE spanning anchor→focus (rowIndex span ×
   * columnId span, in `args.columns` — the VISIBLE-column — order). Structural
   * blanks inside the rectangle (a column that renders no cell on a given row,
   * e.g. an inapplicable owner/tenant side) are simply omitted. Read-only cells
   * ARE included (R8 — the count/sum readout may cover them). Returns the
   * flattened `SelectionCell[]` with identities only (`value` left undefined);
   * the page's `selectCellsWithValues` wrapper enriches each cell's numeric value
   * from its live DOM node before it reaches `useGridSelection`, so the count/sum
   * badge sums this Shift+arrow range just like a mouse drag. NO money write.
   */
  const extendRange = useCallback((dir: Dir): SelectionCell[] => {
    // Anchor = existing anchor, else the current active cell (first shift-step).
    const anchorPos = anchor ?? pos;
    const anchorResolved = resolvePos(anchorPos);
    const focusResolved = resolvePos(pos);
    // No seated active cell → seed the first navigable cell as both anchor+focus.
    if (!anchorResolved || !focusResolved) {
      const first = navRows.find((r) => r.cells.length)?.cells[0];
      if (!first) return [];
      const seed: CellPos = { cellKey: first.cellKey, columnId: first.columnId };
      setAnchor(seed);
      setPos(seed);
      return [{ cellKey: first.cellKey, columnId: first.columnId }];
    }
    // Lock the anchor (first shift-step) so later steps keep spanning from it.
    if (!anchor) setAnchor({ cellKey: anchorResolved.cell.cellKey, columnId: anchorResolved.cell.columnId });
    // Advance the focus one step; edge-stop keeps the current focus.
    const nextFocus = stepFrom(focusResolved.rowIndex, focusResolved.cell.columnId, dir) ?? {
      cellKey: focusResolved.cell.cellKey,
      columnId: focusResolved.cell.columnId,
    };
    setPos(nextFocus);
    const nextFocusResolved = resolvePos(nextFocus);
    if (!nextFocusResolved) return [];
    return rectangle(anchorResolved, nextFocusResolved);
  }, [anchor, pos, navRows, resolvePos, stepFrom, rectangle]);

  /**
   * Task 1 — pure mouse-drag rectangle. Given two arbitrary cell endpoints
   * (drag start + current) as stable `CellRef`s, resolve each against the
   * current navRows and flatten the inclusive rowIndex-span × columnId-span
   * rectangle between them via the SAME `rectangle` machinery Shift+arrow uses
   * (structural blanks omitted, read-only kept). This is what makes a drag
   * A1→D4 select the whole block instead of the mouse path. Returns `[]` if
   * either endpoint no longer resolves in navRows (a filter/refetch dropped it)
   * — no crash, no stray neighbour. NO money write.
   */
  const rectBetween = useCallback(
    (a: CellRef, b: CellRef): SelectionCell[] => {
      const ra = resolvePos(a);
      const rb = resolvePos(b);
      if (!ra || !rb) return []; // an endpoint left the grid → empty rectangle
      return rectangle(ra, rb);
    },
    [resolvePos, rectangle],
  );

  const isActive = useCallback(
    (cellKey: string, columnId: ColumnId) => active?.cellKey === cellKey && active?.columnId === columnId,
    [active],
  );
  const activeNavCell = useCallback(() => resolvePos(pos)?.cell ?? null, [pos, resolvePos]);
  const reset = useCallback(() => { setPos(null); setAnchor(null); }, []);

  return { active, navRows, isActive, setActiveByCell, move, extendRange, rectBetween, activeNavCell, reset };
}
