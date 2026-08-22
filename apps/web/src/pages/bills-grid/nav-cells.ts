// P4 Task 1 — navigable-cell enumerator. Pure function mapping the rendered
// grid to the ORDERED set of navigable cells, mirroring GridUnitRowGroup's
// render branches (grid-table.tsx) exactly. This is the single source of truth
// for "what a nav coordinate can land on"; later P4 tasks build the
// active-cell/arrow-nav layer on top of it.
//
// Reuses `isApplicable` (cell-applicability.ts) so the owner/tenant
// inactive-bearer logic never drifts from the render. A render-parity test
// (nav-cells.test.tsx) guards the rest: editable NavCell count + columns MUST
// equal the rendered <input>s.
import type { GridRow } from "@/api/bills-grid";
import type { ColumnId, GridColumn } from "./columns";
import { isApplicable } from "./cell-applicability";
import { isCellLocked, scalarSettingsLock, type GovernableScalarColumn } from "./row-lock";

export type NavRowType = "unit" | "sub";
export interface NavCell {
  cellKey: string;
  columnId: ColumnId;
  apartmentId: string;
  rowType: NavRowType;
  rowIndex: number;
  editable: boolean;
}
export interface NavRow { key: string; apartmentId: string; rowType: NavRowType; cells: NavCell[]; }

const EXPENSE_TOTALS = new Set<ColumnId>([
  "tenantExpWithSst", "tenantExpNonSst", "ownerExpWithSst", "ownerExpNonSst", "agreementFee", "managementFeeSst",
]);
// Recurring-charges (R9): value-bearing read-only unit cells that are ALWAYS navigable (like
// rental + the expense totals) — the recurring summary totals.
const RECURRING_TOTALS = new Set<ColumnId>(["ownerRecurring", "tenantRecurring"]);
// Recurring-charges (R9; Maintenance joined 2026-08-06): the governable scalar columns —
// still navigable, but applicability-gated (only the active bearer side is a landing cell,
// mirroring the render) and editable only when NOT settings-governed.
const GOVERNABLE_SCALARS = new Set<ColumnId>(["cleaningOwner", "cleaningTenant", "wifiOwner", "wifiTenant", "maintenanceFee"]);

/** Enumerate the ordered navigable cells, mirroring GridUnitRowGroup's render
 * branches. `columns` is the VISIBLE column set (hidden columns already
 * removed by the caller). unitCode has no band and is never a data cell, so it
 * is naturally excluded (it is not in `dataColumns`). */
export function buildNavRows(rows: GridRow[], columns: GridColumn[]): NavRow[] {
  const dataColumns = columns.filter((c) => c.band); // everything except unitCode
  const out: NavRow[] = [];
  let rowIndex = 0;

  for (const row of rows) {
    const hasNested = !row.isWholeUnit;
    // Nullish-safe: `useGridNav` runs this in the page body, OUTSIDE the
    // GridErrorBoundary that wraps GridTable. A malformed row with an undefined
    // `subRows` must NOT throw here (it would blank the whole page above the
    // boundary) — it degrades to zero navigable sub-cells, and GridTable's own
    // render still throws INSIDE the boundary so "Reload grid" fires (R7).
    const inlineSubRow = !hasNested ? row.subRows?.[0] : undefined;
    // Shared with grid-table.tsx via row-lock.ts — these used to hold hand-copied
    // literals of the same predicate. Keyboard nav and the render MUST agree on which
    // cells are editable (nav-cells.test.tsx's render-parity test asserts exactly that),
    // which is precisely the agreement a copied boolean cannot enforce. Now they cannot
    // disagree: same function, at the same CELL grain.
    const cellLocked = (columnId: ColumnId) => isCellLocked(row, columnId);

    // ── unit row ──
    const unitCells: NavCell[] = [];
    for (const col of dataColumns) {
      if (col.grain === "subRow") {
        if (hasNested) continue;              // LockedCell "—" → structural blank
        if (!inlineSubRow) continue;          // LockedCell "—" → structural blank
        const cellKey = inlineSubRow.listingId ?? row.apartmentId;
        const editable = col.id !== "amount" && !cellLocked(col.id);
        unitCells.push({ cellKey, columnId: col.id, apartmentId: row.apartmentId, rowType: "unit", rowIndex, editable });
        continue;
      }
      if (!col.editable) {
        // Value-bearing read-only cells that are ALWAYS navigable: rental + the four expense
        // totals + the two recurring totals.
        if (col.id === "rental" || col.id === "deposit" || EXPENSE_TOTALS.has(col.id) || RECURRING_TOTALS.has(col.id)) {
          unitCells.push({ cellKey: row.apartmentId, columnId: col.id, apartmentId: row.apartmentId, rowType: "unit", rowIndex, editable: false });
        } else if (GOVERNABLE_SCALARS.has(col.id) && isApplicable(row, col.id)) {
          // Governable scalars (R6 refined): the active bearer side is a navigable landing cell;
          // it is EDITABLE only when NOT governed by an enabled recurring def and the row isn't
          // billed-locked — otherwise read-only (settings-controlled). The lock predicate is
          // row-lock.ts's shared scalarSettingsLock, the same one the render consults.
          const editable = scalarSettingsLock(row, col.id as GovernableScalarColumn) === false && !cellLocked(col.id);
          unitCells.push({ cellKey: row.apartmentId, columnId: col.id, apartmentId: row.apartmentId, rowType: "unit", rowIndex, editable });
        }
        continue;
      }
      // editable unit-grain col
      if (!isApplicable(row, col.id)) continue; // inactive-bearer LockedCell "—" → blank
      unitCells.push({ cellKey: row.apartmentId, columnId: col.id, apartmentId: row.apartmentId, rowType: "unit", rowIndex, editable: !cellLocked(col.id) });
    }
    out.push({ key: row.apartmentId, apartmentId: row.apartmentId, rowType: "unit", cells: unitCells });
    rowIndex += 1;

    // ── nested sub-rows ──
    if (hasNested) {
      for (const sub of row.subRows ?? []) {
        const cells: NavCell[] = [];
        for (const col of dataColumns) {
          if (col.grain !== "subRow") {
            if (col.id === "rental" || col.id === "deposit") {
              // off-grain but value-bearing (SubRow.rental) → navigable read-only
              cells.push({ cellKey: sub.listingId, columnId: col.id, apartmentId: row.apartmentId, rowType: "sub", rowIndex, editable: false });
            }
            continue; // other off-grain cells render null → structural blank
          }
          const editable = col.id !== "amount" && !cellLocked(col.id);
          cells.push({ cellKey: sub.listingId, columnId: col.id, apartmentId: row.apartmentId, rowType: "sub", rowIndex, editable });
        }
        out.push({ key: sub.listingId, apartmentId: row.apartmentId, rowType: "sub", cells });
        rowIndex += 1;
      }
    }
    // prior-month strips are aggregate colspan cells → never navigable (skipped)
  }
  return out;
}
