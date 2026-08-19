// Bills & Expenses Grid — programmatic exceljs exporter (UI Task 8). PURE data
// module: no JSX, no fetch, no store write, no staged-edit read. `exceljs` is
// already a dependency (apps/web/package.json) — nothing new is added here.
//
// Deliberately NOT a reuse of apps/web/src/lib/xlsx-export.ts: that module
// fetches a fixed commission-claim template and pokes hard-coded cell
// addresses (E13, N13, A19+). It does zero `mergeCells` and cannot express
// this grid's variable-width merged band headers or variable number of prior-
// month strips. This file owns its own, independent layout.
//
// Row 1 = merged band headers (one merge per CURRENT_COLUMNS `band`, grouping
// consecutive columns — mirrors grid-table.tsx's groupBands, kept local here
// since that function isn't exported). Row 2 = per-column headers. Then one
// block per apartment: the current-period unit row (+ nested tenant sub-rows
// when the apartment is partitioned, same `hasNestedSubRows` rule grid-table
// uses), followed by one compact prior-month strip per period in `periods`
// that the row actually carries data for (R5: prior strips show ONLY
// cleaning/tnb/air/wifi/others — no rental, no meter columns, no owner/tenant
// split, no SST split).
import ExcelJS from "exceljs";
import type { GridRow, GridSubRow, PriorMonthStrip } from "@/api/bills-grid";
import type { ColumnId, GridColumn } from "./columns";
import { cleaningSeed } from "./cell-seed";
import { isApplicable } from "./cell-applicability";

const WORKSHEET_NAME = "Tenant & Owner Billing";
const DOWNLOAD_FILENAME = "tenant-owner-billing.xlsx";

// ── small money/parse helpers (display-only; never a calc input) ───────────

function toNumberOrNull(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** total - part, rounded to 2dp. Mirrors grid-table.tsx's subtractMoney (kept
 * local here since that helper isn't exported). Display-only. */
function subtractMoney(total: string, part: string): number {
  const t = Number(total);
  const p = Number(part);
  return Number(((Number.isNaN(t) ? 0 : t) - (Number.isNaN(p) ? 0 : p)).toFixed(2));
}

function mergeRange(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number): void {
  if (r1 === r2 && c1 === c2) return; // single cell — nothing to merge
  ws.mergeCells(r1, c1, r2, c2);
}

// ── row 1 (band headers) + row 2 (per-column headers) ──────────────────────

/** Walks `columns` in order, merging each run of consecutive same-band
 * columns into one row-1 cell (e.g. TNB spans previousKwh..amount, a 4-column
 * merge) and vertically merging any band-less column (unitCode) across rows
 * 1-2. Column order is the FROZEN contract from columns.ts — this function
 * relies on same-band columns being contiguous. */
function writeHeaderRows(ws: ExcelJS.Worksheet, columns: GridColumn[]): void {
  let col = 1;
  let i = 0;
  while (i < columns.length) {
    const current = columns[i];
    if (!current.band) {
      mergeRange(ws, 1, col, 2, col);
      ws.getCell(1, col).value = current.header;
      col += 1;
      i += 1;
      continue;
    }
    let j = i;
    while (j < columns.length && columns[j].band === current.band) j += 1;
    const span = j - i;
    mergeRange(ws, 1, col, 1, col + span - 1);
    ws.getCell(1, col).value = current.band;
    for (let k = 0; k < span; k += 1) {
      ws.getCell(2, col + k).value = columns[i + k].header;
    }
    col += span;
    i = j;
  }
}

// ── unit-grain / sub-row-grain cell values ──────────────────────────────────

/**
 * Value for a unit-grain data column (everything except unitCode and the TNB
 * sub-row-grain trio).
 *
 * Every bearer-driven column asks `isApplicable` — the SAME function the grid renders
 * from — rather than restating the rule. This file used to keep its own copies
 * (`cleaningBearer !== "tenant"`, `airPattern === "tenant_direct"`, …) and they drifted
 * exactly as you would expect: the AIR pair went on splitting by a value the Unit setting
 * drawer could no longer write, and `tnbOwner` had no gate at all, so a sheet reported a
 * TNB amount for a unit whose on-screen cell reads "—" and whose Bill discards it. One
 * call, no second rule to forget (2026-08-16).
 */
function unitColumnValue(row: GridRow, columnId: ColumnId): string | number | null {
  const entry = row.entry;
  /** The cell's value when it IS the active side; `null` collapses it to a blank cell. */
  const whenApplicable = (value: string | number | null) => (isApplicable(row, columnId) ? value : null);

  switch (columnId) {
    case "rental":
      // Task 6: rental moved off `entry` onto the whole-unit tenancy's own
      // sub-row (SubRow.rental) — mirrors grid-table.tsx's on-screen Rental
      // cell (row.subRows[0]?.rental), same "export mirrors the on-screen
      // view" rule cleaningOwner/cleaningTenant already follow below.
      return toNumberOrNull(row.subRows[0]?.rental ?? null);
    case "cleaningOwner":
    case "cleaningTenant":
      // cleaningSeed (cell-seed.ts) falls back to bearerConfig.cleaningRecurringAmount for
      // a never-Saved month, same as grid-table.tsx's seedValue — reading entry?.cleaning
      // alone exported a blank where the screen showed the recurring default.
      return whenApplicable(toNumberOrNull(cleaningSeed(row)));
    case "tnbOwner":
      return whenApplicable(toNumberOrNull(entry?.tnbTotal));
    case "airOwner":
    case "airTenant":
      return whenApplicable(toNumberOrNull(entry?.airSelangor));
    case "wifiOwner":
    case "wifiTenant":
      return whenApplicable(toNumberOrNull(entry?.wifi));
    case "maintenanceFee":
      return toNumberOrNull(entry?.maintenanceFee);
    case "tenantExpWithSst":
      return toNumberOrNull(row.expenses.tenant.withSstTotal);
    case "tenantExpNonSst":
      return subtractMoney(row.expenses.tenant.total, row.expenses.tenant.withSstTotal);
    case "ownerExpWithSst":
      return toNumberOrNull(row.expenses.owner.withSstTotal);
    case "ownerExpNonSst":
      return subtractMoney(row.expenses.owner.total, row.expenses.owner.withSstTotal);
    // Recurring-charges (R9): CUSTOM recurring totals — export mirrors the on-screen read-only cell.
    case "ownerRecurring":
      return toNumberOrNull(row.recurring?.owner.total ?? null);
    case "tenantRecurring":
      return toNumberOrNull(row.recurring?.tenant.total ?? null);
    default:
      return null;
  }
}

function subRowValue(subRow: GridSubRow, columnId: ColumnId): number | null {
  switch (columnId) {
    case "previousKwh":
      return toNumberOrNull(subRow.previousKwh);
    case "currentKwh":
      return toNumberOrNull(subRow.currentKwh);
    case "amount":
      return toNumberOrNull(subRow.amount);
    default:
      return null;
  }
}

// ── compact prior-month strip row (R5: 5 values only) ───────────────────────

/** One compact strip per prior period: period label, then merged cleaning
 * (2 cols) / tnb (4 cols) / air (2 cols) / wifi (2 cols) / others (remaining
 * cols) ranges — same grouping grid-table.tsx renders via colSpan, so a
 * printed export visually matches the on-screen strip. `others` absorbs
 * whatever width is left (rental + maintenanceFee + both expense splits on
 * the full 17-column CURRENT_COLUMNS layout), so this stays correct even if
 * a caller passes a narrower, hidden-columns-filtered `columns` array. */
function writePriorStripRow(ws: ExcelJS.Worksheet, r: number, prior: PriorMonthStrip, totalCols: number): void {
  ws.getCell(r, 1).value = prior.period;

  const cleaningStart = 2;
  const cleaningSpan = 2;
  const tnbStart = cleaningStart + cleaningSpan;
  const tnbSpan = 4;
  const airStart = tnbStart + tnbSpan;
  const airSpan = 2;
  const wifiStart = airStart + airSpan;
  const wifiSpan = 2;
  const othersStart = wifiStart + wifiSpan;
  const othersSpan = Math.max(1, totalCols - (othersStart - 1));

  mergeRange(ws, r, cleaningStart, r, cleaningStart + cleaningSpan - 1);
  ws.getCell(r, cleaningStart).value = prior.cleaning ?? "—";

  mergeRange(ws, r, tnbStart, r, tnbStart + tnbSpan - 1);
  ws.getCell(r, tnbStart).value = prior.tnb ?? "—";

  mergeRange(ws, r, airStart, r, airStart + airSpan - 1);
  ws.getCell(r, airStart).value = prior.air ?? "—";

  mergeRange(ws, r, wifiStart, r, wifiStart + wifiSpan - 1);
  ws.getCell(r, wifiStart).value = prior.wifi ?? "—";

  mergeRange(ws, r, othersStart, r, othersStart + othersSpan - 1);
  ws.getCell(r, othersStart).value = prior.others;
}

// ── one apartment's block: unit row (+ nested sub-rows) + prior strips ─────

/** Writes one apartment's rows starting at `startRow`; returns the next free
 * row. Prior strips are matched against `periods.slice(1)` (everything after
 * the current period) by `period` key — a period the row has no strip for
 * (e.g. a newly-onboarded apartment) is silently skipped rather than printing
 * a blank/misleading row. */
function writeApartmentBlock(
  ws: ExcelJS.Worksheet,
  startRow: number,
  row: GridRow,
  columns: GridColumn[],
  periods: string[],
): number {
  let cursor = startRow;

  // R2/R3 (Task 6 re-base): grain-lock is now server-derived via
  // `row.isWholeUnit` — a partitioned apartment nests its readings as tenant
  // sub-rows; a whole-unit tenancy shows its single reading inline. MUST stay
  // byte-identical to grid-table.tsx's own `hasNestedSubRows` — a mismatch
  // breaks inline-vs-nested rendering parity between the table and the export.
  const hasNestedSubRows = !row.isWholeUnit;
  const inlineSubRow = !hasNestedSubRows ? row.subRows[0] : undefined;

  columns.forEach((col, idx) => {
    const c = idx + 1;
    if (col.id === "unitCode") {
      ws.getCell(cursor, c).value = row.unitCode;
      return;
    }
    if (col.grain === "subRow") {
      ws.getCell(cursor, c).value = inlineSubRow ? subRowValue(inlineSubRow, col.id) : null;
      return;
    }
    ws.getCell(cursor, c).value = unitColumnValue(row, col.id);
  });
  cursor += 1;

  if (hasNestedSubRows) {
    for (const subRow of row.subRows) {
      columns.forEach((col, idx) => {
        const c = idx + 1;
        if (col.id === "unitCode") {
          ws.getCell(cursor, c).value = `↳ ${subRow.partyName ?? "Vacant"}`;
          return;
        }
        if (col.grain === "subRow") {
          ws.getCell(cursor, c).value = subRowValue(subRow, col.id);
        }
        // Off-grain (unit-grain) columns stay blank on a nested tenant row —
        // the real value lives on the unit row above (grain discipline, R3).
      });
      cursor += 1;
    }
  }

  const priorPeriods = periods.slice(1);
  const priorByPeriod = new Map(row.priorMonths.map((p) => [p.period, p] as const));
  for (const period of priorPeriods) {
    const prior = priorByPeriod.get(period);
    if (!prior) continue;
    writePriorStripRow(ws, cursor, prior, columns.length);
    cursor += 1;
  }

  return cursor;
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Builds the workbook. Read-only + side-effect-free: no store write, no
 * staged-edit change, no network call.
 *
 * Refuses a zero-row grid outright (`Error("Nothing to export")`) so the
 * ui-10 Export button can simply disable when the filtered grid is empty
 * instead of reaching this function and surfacing a confusing blank file.
 */
export async function buildGridWorkbook(
  rows: GridRow[],
  columns: GridColumn[],
  periods: string[],
): Promise<ExcelJS.Workbook> {
  if (rows.length === 0) {
    throw new Error("Nothing to export");
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(WORKSHEET_NAME);
  writeHeaderRows(ws, columns);

  let cursor = 3;
  for (let idx = 0; idx < rows.length; idx += 1) {
    cursor = writeApartmentBlock(ws, cursor, rows[idx], columns, periods);
    if (idx > 0 && idx % 200 === 0) {
      // Yield to the event loop periodically so a very large export (many
      // apartments) doesn't block the main thread while rows are built.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return wb;
}

/**
 * Builds the workbook and triggers a browser download. Any exceljs
 * serialization error (e.g. `writeBuffer` failure) propagates unchanged to
 * the caller so ui-10 can toast it — this function does not swallow errors.
 */
export async function exportGridToXlsx(rows: GridRow[], columns: GridColumn[], periods: string[]): Promise<void> {
  const wb = await buildGridWorkbook(rows, columns, periods);
  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = DOWNLOAD_FILENAME;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
