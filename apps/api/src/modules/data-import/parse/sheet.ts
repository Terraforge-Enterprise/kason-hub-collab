import ExcelJS from "exceljs";
import type { RawTenantRow } from "../types";
import {
  parseRentalExpression,
  splitMultiTenant,
  parseGender,
  parseTermMonths,
  parseDateCell,
  latestCumulativeReading,
} from "./cells";

/** RS Tenant List is an electricity-bill worksheet, NOT a roster — excluded (crud-gate 2026-06-15). */
export const TENANT_SHEETS = [
  "PV9 Tenant List",
  "UCSI 2 Tenant List",
  "RIANA SOUTH Tenant",
  "Other Condos",
] as const;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function cellText(c: ExcelJS.CellValue): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c === "object" && "text" in (c as object))
    return String((c as { text: unknown }).text).trim() || null;
  if (typeof c === "object" && "result" in (c as object))
    return String((c as { result: unknown }).result).trim() || null;
  const s = String(c).trim();
  return s.length ? s : null;
}

function cellRaw(c: ExcelJS.CellValue): unknown {
  if (c && typeof c === "object" && "result" in (c as object))
    return (c as { result: unknown }).result;
  return c;
}

/** Choose the header row: among the first 8 rows, the one containing "name" + ("unit"|"room"). */
function findHeaderRow(ws: ExcelJS.Worksheet): number {
  let best = 1;
  let bestScore = -1;
  for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
    const vals: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      const t = cellText(cell.value);
      if (t) vals.push(t.toLowerCase());
    });
    const joined = vals.join(" ");
    const score =
      vals.length +
      (joined.includes("name") && (joined.includes("unit") || joined.includes("room")) ? 100 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

type ColMap = Record<string, number>;

function buildColMap(
  ws: ExcelJS.Worksheet,
  headerRow: number,
): { map: ColMap; readingCols: number[] } {
  const map: ColMap = {};
  const readingCols: number[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = (cellText(cell.value) ?? "").toLowerCase();
    if (!h) return;
    const set = (k: string) => {
      if (map[k] === undefined) map[k] = col;
    };
    if (h.includes("name")) set("name");
    else if (h.includes("unit")) set("unit");
    else if (h.includes("room")) set("room");
    else if (h.includes("carpark")) set("carpark");
    else if (h.includes("gender")) set("gender");
    else if (h.includes("rent")) set("rent");
    else if (h.includes("access") || h === "card") set("card");
    else if (h.includes("pax")) set("pax");
    else if (h.includes("ic")) set("ic");
    else if (h.includes("contact") || h.includes("phone")) set("phone");
    else if (h.includes("email")) set("email");
    else if (h.includes("move in") || h.includes("start date")) set("movein");
    else if (h.includes("move out") || h.includes("end date")) set("moveout");
    else if (h.includes("period") || h === "tenancy") set("period");
    else if (h.includes("agent")) set("agent");
    else if (h.includes("condo")) set("condo");

    const isMonth = MONTHS.some((m) => h.startsWith(m));
    if (h.includes("meter") || h.includes("reading") || (isMonth && /\d/.test(h)))
      readingCols.push(col);
  });
  return { map, readingCols };
}

export function parseTenantSheet(ws: ExcelJS.Worksheet, sheetName: string): RawTenantRow[] {
  const headerRow = findHeaderRow(ws);
  const { map, readingCols } = buildColMap(ws, headerRow);
  const out: RawTenantRow[] = [];
  const get = (row: ExcelJS.Row, key: string): ExcelJS.CellValue =>
    map[key] === undefined ? null : row.getCell(map[key]!).value;

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const nameText = cellText(get(row, "name"));
    if (!nameText) continue;
    const people = splitMultiTenant(nameText);
    const rental = parseRentalExpression(cellRaw(get(row, "rent")));
    const readings = readingCols.map((c) => {
      const v = cellRaw(row.getCell(c).value);
      return typeof v === "number"
        ? v
        : v === null || v === undefined || v === ""
          ? null
          : Number(v);
    });
    const reading = latestCumulativeReading(readings);
    out.push({
      sheet: sheetName,
      rowNumber: r,
      propertyName: cellText(get(row, "condo")) ?? sheetName,
      unitCode: cellText(get(row, "unit")),
      roomName: cellText(get(row, "room")),
      tenantNameRaw: people[0] ?? null,
      coTenantNames: people.slice(1),
      rentalRoom: rental.room,
      rentalCarpark: rental.carpark,
      carparkCol: cellText(get(row, "carpark")),
      accessCardNo: cellText(get(row, "card")),
      numberOfPax: ((): number | null => {
        const v = cellRaw(get(row, "pax"));
        const n = Number(v);
        return Number.isFinite(n) && v !== null && v !== "" ? Math.trunc(n) : null;
      })(),
      idNumber: cellText(get(row, "ic")),
      phoneRaw: cellText(get(row, "phone")),
      email: cellText(get(row, "email")),
      gender: parseGender(cellText(get(row, "gender"))),
      moveIn: parseDateCell(cellRaw(get(row, "movein"))),
      moveOut: parseDateCell(cellRaw(get(row, "moveout"))),
      termMonths: parseTermMonths(cellText(get(row, "period"))),
      agentLabel: cellText(get(row, "agent")),
      latestReading: reading.value,
      readingMonotonic: reading.monotonic,
    });
  }
  return out;
}

export function parseWorkbook(wb: ExcelJS.Workbook): RawTenantRow[] {
  const rows: RawTenantRow[] = [];
  for (const name of TENANT_SHEETS) {
    const ws = wb.getWorksheet(name);
    if (ws) rows.push(...parseTenantSheet(ws, name));
  }
  return rows;
}
