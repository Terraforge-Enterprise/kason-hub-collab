import type { GridRow } from "@/api/bills-grid";
// R31(e): an Excel-style per-column value filter CROSSED with a date range over the month
// strips. Distinct from R29's "Categorize" property filter (ui-10).
export interface ColumnFilters { [columnId: string]: string }        // substring, case-insensitive
export interface DateRange { from: string | null; to: string | null } // inclusive periodMonth bounds

/**
 * Reads the filterable field for a columnId off a GridRow. `unitCode` is the
 * minimum required column (R31e acceptance uses it); `propertyId` and the
 * unit-grain entry amounts are included as useful additional filter targets.
 * Unknown/unsupported columnIds resolve to `null` (never match a non-empty
 * needle, per `applyFilters`'s `String(null)` coercion below).
 */
export function cellValue(row: GridRow, columnId: string): string | number | null {
  switch (columnId) {
    case "unitCode": {
      // Broadened search target — the single toolbar filter box matches unit code OR
      // property OR owner name OR tenant name OR TENANT phone (owner phone is intentionally
      // NOT shown or searched). Tenant phones are included BOTH as stored (formatted) and
      // digit-stripped, so "012-345" and "012345" both hit.
      const phones = row.subRows.map((s) => s.partyPhone).filter(Boolean) as string[];
      const parts = [
        row.unitCode,
        row.propertyName,
        row.ownerName,
        ...phones,
        ...phones.map((p) => p.replace(/\D/g, "")),
        ...row.subRows.map((s) => s.partyName),
      ];
      return parts.filter(Boolean).join(" ");
    }
    case "propertyId":
      return row.propertyId;
    case "rental":
      // Task 6: rental moved off `entry` onto the whole-unit tenancy's own
      // sub-row (SubRow.rental) now that entry.rental is gone.
      return row.subRows[0]?.rental ?? null;
    case "cleaningOwner":
    case "cleaningTenant":
      return row.entry?.cleaning ?? null;
    case "tnbOwner":
      return row.entry?.tnbTotal ?? null;
    case "airOwner":
    case "airTenant":
      return row.entry?.airSelangor ?? null;
    case "wifiOwner":
    case "wifiTenant":
      return row.entry?.wifi ?? null;
    case "maintenanceFee":
      return row.entry?.maintenanceFee ?? null;
    // Recurring-charges (R9): filter by the CUSTOM recurring totals.
    case "ownerRecurring":
      return row.recurring?.owner.total ?? null;
    case "tenantRecurring":
      return row.recurring?.tenant.total ?? null;
    default:
      return null;
  }
}

export function applyFilters(
  rows: GridRow[], periods: string[], columnFilters: ColumnFilters, dateRange: DateRange,
): { rows: GridRow[]; periods: string[] } {
  const visibleRows = rows.filter((row) =>
    Object.entries(columnFilters).every(([columnId, needle]) => {
      if (!needle) return true;
      return String(cellValue(row, columnId) ?? "").toLowerCase().includes(needle.toLowerCase());
    }),
  );
  const visiblePeriods = periods.filter(
    (p) => (!dateRange.from || p >= dateRange.from) && (!dateRange.to || p <= dateRange.to),
  );
  return { rows: visibleRows, periods: visiblePeriods };
}
