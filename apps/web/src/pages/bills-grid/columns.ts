// Bills & Expenses Grid — column contract (UI Task 3). FROZEN source of truth,
// shared with the ui-8 exporter: column order and ids here must stay in sync
// with whatever the exporter reads. Do not reorder without updating both.
export type ColumnId =
  | "unitCode" | "rental" | "cleaningOwner" | "cleaningTenant"
  | "tnbOwner" | "previousKwh" | "currentKwh" | "amount"
  | "airOwner" | "airTenant" | "wifiOwner" | "wifiTenant"
  | "maintenanceFee" | "ownerRecurring" | "tenantRecurring"
  | "tenantExpWithSst" | "tenantExpNonSst"
  | "ownerExpWithSst" | "ownerExpNonSst";

export interface GridColumn {
  id: ColumnId; header: string; band?: string;
  grain: "unit" | "subRow"; editable: boolean; numeric: boolean;
}

// Order is load-bearing: matches the client's mock header AND the exporter.
// "AIR" is Air Selangor = WATER. Never label it Aircond.
export const CURRENT_COLUMNS: GridColumn[] = [
  { id: "unitCode",         header: "Unit",            grain: "unit",   editable: false, numeric: false },
  { id: "rental",           header: "Tenant",          band: "Rental",  grain: "unit",   editable: false, numeric: true },
  // Recurring-charges (R9): cleaning/WiFi are settings-controlled recurring fees, generated
  // read-only per period like rental — NOT editable grid cells (backend also 409s a direct edit).
  { id: "cleaningOwner",    header: "Owner",           band: "Cleaning", grain: "unit",  editable: false, numeric: true },
  { id: "cleaningTenant",   header: "Tenant",          band: "Cleaning", grain: "unit",  editable: false, numeric: true },
  { id: "tnbOwner",         header: "Owner",           band: "TNB",     grain: "unit",   editable: true,  numeric: true },
  { id: "previousKwh",      header: "Previous Meter (kwh)", band: "TNB", grain: "subRow", editable: true, numeric: true },
  { id: "currentKwh",       header: "Current Meter (kwh)",  band: "TNB", grain: "subRow", editable: true, numeric: true },
  { id: "amount",           header: "Amount",          band: "TNB",     grain: "subRow", editable: false, numeric: true },
  { id: "airOwner",         header: "Owner",           band: "AIR",     grain: "unit",   editable: true,  numeric: true },
  { id: "airTenant",        header: "Tenant",          band: "AIR",     grain: "unit",   editable: true,  numeric: true },
  { id: "wifiOwner",        header: "Owner",           band: "WiFi",    grain: "unit",   editable: false, numeric: true },
  { id: "wifiTenant",       header: "Tenant",          band: "WiFi",    grain: "unit",   editable: false, numeric: true },
  // editable:false since 2026-08-06 — maintenanceFee joined the governable scalars: like
  // cleaning/wifi it renders an EditableCell only while no enabled recurring def governs it.
  { id: "maintenanceFee",   header: "Owner",           band: "Maintenance Fee", grain: "unit", editable: false, numeric: true },
  // Recurring-charges (R9): read-only CUSTOM recurring totals (owner/tenant) — cleaning/WiFi are
  // NOT re-counted here (they have their own columns). Opens a read-only itemised dialog.
  { id: "ownerRecurring",   header: "Owner",           band: "Recurring", grain: "unit", editable: false, numeric: true },
  { id: "tenantRecurring",  header: "Tenant",          band: "Recurring", grain: "unit", editable: false, numeric: true },
  { id: "tenantExpWithSst", header: "With SST",        band: "Tenant Expenses", grain: "unit", editable: false, numeric: true },
  { id: "tenantExpNonSst",  header: "Non SST",         band: "Tenant Expenses", grain: "unit", editable: false, numeric: true },
  { id: "ownerExpWithSst",  header: "With SST",        band: "Owner Expenses",  grain: "unit", editable: false, numeric: true },
  { id: "ownerExpNonSst",   header: "Non SST",         band: "Owner Expenses",  grain: "unit", editable: false, numeric: true },
];

// R5: prior-month strip carries ONLY these five. No rental, no maintenance fee,
// no meter columns, no owner/tenant split, no SST split.
export const PRIOR_MONTH_COLUMNS = ["cleaning", "tnb", "air", "wifi", "others"] as const;

/**
 * Which settlement bucket (server-derived payment state) each column reads, driving
 * the greyed-out + green-tick "this line is paid" affordance.
 *
 * A `Record<ColumnId, …>` — NOT a partial lookup — so adding a column is a BUILD
 * ERROR until someone decides whether it carries money. `null` = it does not:
 *   • `unitCode` is an identifier.
 *   • `rental` is server-derived display, never minted as a grid charge.
 *   • `previousKwh`/`currentKwh` are meter readings; the money they produce is the
 *     tenant electricity charge, which `amount` shows.
 * `amount` (the per-room TNB share) reads the TENANT electricity bucket, whereas
 * `tnbOwner` reads the OWNER one — the same band, two different bills.
 *
 * Both SST columns of an expense pair share their side's bucket: the split is a
 * presentation of one set of expense charges, and settlement is not tracked per
 * SST-ness. So both grey together, which is honest — neither claims the other is paid.
 */
export const SETTLEMENT_BUCKET_OF_COLUMN: Record<ColumnId, import("@kason/shared").SettlementBucket | null> = {
  unitCode: null,
  rental: null,
  previousKwh: null,
  currentKwh: null,
  cleaningOwner: "cleaningOwner",
  cleaningTenant: "cleaningTenant",
  tnbOwner: "tnbOwner",
  amount: "tnbTenant",
  airOwner: "airOwner",
  airTenant: "airTenant",
  wifiOwner: "wifiOwner",
  wifiTenant: "wifiTenant",
  maintenanceFee: "maintenanceOwner",
  ownerRecurring: "recurringOwner",
  tenantRecurring: "recurringTenant",
  tenantExpWithSst: "expensesTenant",
  tenantExpNonSst: "expensesTenant",
  ownerExpWithSst: "expensesOwner",
  ownerExpNonSst: "expensesOwner",
};
