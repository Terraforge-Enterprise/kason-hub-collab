// Bills & Expenses Grid — Copy (Ctrl/Cmd+C) planner. Pure (no DOM): resolves the
// current selection into a SINGLE rectangular copy plan over the nav grid, so the
// clipboard payload is spreadsheet-compatible TSV. The page reads each planned
// cell's DISPLAYED value from the DOM and serialises via `matrixToTsv`.
//
// User contract (locked): copy is ONE rectangular range. A non-contiguous
// multi-range selection (ctrl-added ranges, or a hole) is NEVER silently
// flattened and NEVER pulls in unselected cells — it is refused, and the page
// shows a "select a single rectangular range" cue instead.
import type { NavRow, NavCell } from "./nav-cells";

export type CopyStatus = "empty" | "noncontiguous" | "ok";

export interface CopyPlan {
  status: CopyStatus;
  // Present only when status === "ok": a row-major matrix over the selection's
  // bounding box. Each entry is the NavCell at that (row, column) coordinate, or
  // `null` for a STRUCTURAL BLANK inside the rectangle (a column that renders no
  // navigable cell on that row — e.g. an inactive owner/tenant side). Blanks are
  // emitted as an empty TSV field so columns stay aligned when pasted.
  matrix?: (NavCell | null)[][];
}

const keyOf = (c: { cellKey: string; columnId: string }) => `${c.cellKey}:${c.columnId}`;

/**
 * Resolve the selected cells into a single rectangular copy plan.
 *
 * The coordinate system mirrors the selection's own producer
 * (use-grid-nav.rectangle): the row axis is the navRows index and the column axis
 * is `dataColumns` order. The bounding box spans [minRow..maxRow] × [minCol..maxCol]
 * over the selected cells.
 *
 * Non-contiguous guard: if ANY navigable cell inside the bounding box is not in
 * the selection, the selection covers more than one rectangle (or has a hole) →
 * "noncontiguous". Structural blanks are NOT holes: they carry no navigable cell,
 * so they are absent from both the selection and the enumeration, and are emitted
 * as "" — they never trip the guard.
 */
export function planRectangularCopy(
  navRows: NavRow[],
  dataColumns: { id: string }[],
  selected: { cellKey: string; columnId: string }[],
): CopyPlan {
  if (selected.length === 0) return { status: "empty" };

  const colIndex = new Map<string, number>(dataColumns.map((c, i) => [c.id, i]));
  const selectedKeys = new Set(selected.map(keyOf));

  // Build, in ONE pass over navRows: a coord→NavCell lookup and a key→coord map.
  // The navRows array index is the row coordinate (matches NavCell.rowIndex).
  const cellAt = new Map<string, NavCell>(); // `${row}:${col}` → cell
  const coordOfKey = new Map<string, { row: number; col: number }>();
  navRows.forEach((r, row) => {
    for (const c of r.cells) {
      const col = colIndex.get(c.columnId);
      if (col == null) continue; // column not in the visible set — skip defensively
      cellAt.set(`${row}:${col}`, c);
      coordOfKey.set(keyOf(c), { row, col });
    }
  });

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const s of selected) {
    const co = coordOfKey.get(keyOf(s));
    if (!co) continue; // a selected cell that no longer resolves (filtered out) — ignore
    minRow = Math.min(minRow, co.row);
    maxRow = Math.max(maxRow, co.row);
    minCol = Math.min(minCol, co.col);
    maxCol = Math.max(maxCol, co.col);
  }
  if (!Number.isFinite(minRow)) return { status: "empty" };

  const matrix: (NavCell | null)[][] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    const line: (NavCell | null)[] = [];
    for (let col = minCol; col <= maxCol; col += 1) {
      const cell = cellAt.get(`${row}:${col}`) ?? null;
      if (cell && !selectedKeys.has(keyOf(cell))) {
        // A navigable cell inside the bounding box that is NOT selected ⇒ the
        // selection is more than one rectangle. Refuse (never flatten).
        return { status: "noncontiguous" };
      }
      line.push(cell); // null (structural blank) → "" in the TSV
    }
    matrix.push(line);
  }
  return { status: "ok", matrix };
}

/** Serialise a copy matrix to spreadsheet-compatible TSV. `valueOf` resolves a
 * planned NavCell to its displayed string (the page reads the live DOM value);
 * structural blanks (null) become empty fields. Rows join with "\n", cells "\t". */
export function matrixToTsv(matrix: (NavCell | null)[][], valueOf: (c: NavCell) => string): string {
  return matrix.map((line) => line.map((c) => (c ? valueOf(c) : "")).join("\t")).join("\n");
}

/** Count of real (non-blank) cells in a copy matrix — for the "Copied N cells" cue. */
export function countCells(matrix: (NavCell | null)[][]): number {
  return matrix.reduce((acc, line) => acc + line.filter(Boolean).length, 0);
}
