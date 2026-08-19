// tenant_direct silent-drop warning (2026-07-27).
//
// "Tenant pays directly" means the tenant settles with the provider themselves, so the grid never
// bills that utility: shapeUtilityPool (apps/api/src/modules/bills-grid/shape.ts) removes it from
// the tenant pool, and mintItemizedCharges skips the component outright
// (`if (fundedBy === "tenant_direct") return null` — "never billed via the grid").
//
// The cells, however, still HOLD whatever was typed before the pattern was set — or typed into
// AIR's tenant-side cell, which stays applicable under tenant_direct precisely so the amount can
// be RECORDED. Billing then discards it with no signal. The grid's own wire map even assumed the
// TNB case was impossible ("TNB is never tenant-direct"), while the Unit setting drawer has always
// offered the option.
//
// This module is the PURE detector behind the pre-Bill warning: given the rows about to be billed,
// which of them carry a non-zero amount that the Bill will silently drop, and why. It reports —
// it never blocks; "Tenant pays directly" with a recorded amount is a legitimate bookkeeping
// state, so the admin confirms rather than being stopped.
import type { GridRow } from "@/api/bills-grid";
import { isProviderPaidByTenant } from "./cell-applicability";

/** One unit's typed-but-unbillable amounts, ready to render. */
export interface UnbillableRow {
  unitCode: string;
  /** Human-readable lines, e.g. `TNB RM 500.00`. Never empty when the row is returned. */
  items: string[];
}

function amount(raw: string | null | undefined): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function money(raw: string): string {
  return `RM ${Number(raw).toFixed(2)}`;
}

/**
 * The units among `rows` that will silently lose a typed amount at Bill time because their TNB /
 * AIR pattern is `tenant_direct`.
 *
 * Reads the ENTRY's snapshotted pattern — the same value `isApplicable` treats as live once an
 * entry exists — so the warning and the greyed-out cells can never disagree. A row with no entry
 * has nothing typed yet and is never reported.
 */
export function findUnbillableAmounts(rows: GridRow[]): UnbillableRow[] {
  const out: UnbillableRow[] = [];
  for (const row of rows) {
    const entry = row.entry;
    if (!entry) continue;
    const items: string[] = [];
    if (isProviderPaidByTenant(entry.tnbPattern) && amount(entry.tnbTotal) > 0) {
      items.push(`TNB ${money(entry.tnbTotal as string)}`);
    }
    if (isProviderPaidByTenant(entry.airPattern) && amount(entry.airSelangor) > 0) {
      items.push(`AIR (water) ${money(entry.airSelangor as string)}`);
    }
    if (items.length > 0) out.push({ unitCode: row.unitCode, items });
  }
  return out;
}
