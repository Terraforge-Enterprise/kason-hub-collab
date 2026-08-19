// packages/shared/src/constants/scalar-recurring.ts
/**
 * The bills-grid SCALAR rows that support a fixed monthly ("recurring") amount.
 *
 * A scalar recurring kind snapshots its amount straight onto one `UnitBillsGridEntry`
 * money column and locks that column in the grid. This is the ONE place that mapping
 * lives — `governingScalarKinds`, the recurring snapshot writer, the save write-guard,
 * the bearer-config DTO and the drawer UI all derive from it, so adding a fifth row is
 * a single entry here rather than five hand-edited ternary chains.
 *
 * CUSTOM is deliberately absent: it is not a scalar. A CUSTOM definition writes a
 * `GridEntryRecurringLine` child row instead of an entry column, so it has no
 * `entryAmountField` and never participates in scalar governance or cell locking.
 *
 * BEARER IS NOT LISTED ON PURPOSE. A recurring definition fixes the AMOUNT only; who
 * bears the cost stays the unit Setting drawer's own Owner/Tenant control, which
 * remains editable while the tick is on. One writer per fact.
 *
 * Adding a kind requires an entry money column to write to.
 */
/**
 * `entryAmountField` is the DB column; `saveBodyField` is the key the grid's save payload
 * uses for it. They are NOT always the same — the raw provider-bill columns are suffixed
 * `Raw` in the schema but arrive as `tnbTotal` / `airSelangor` on the wire — so both are
 * listed explicitly. Deriving one from the other would silently mis-key the write guard.
 */
export const SCALAR_RECURRING_KINDS = {
  CLEANING: { entryAmountField: "cleaning", saveBodyField: "cleaning", entryNatureField: "cleaningNature", entryBearerField: "cleaningBearer", label: "Cleaning" },
  WIFI: { entryAmountField: "wifi", saveBodyField: "wifi", entryNatureField: "wifiNature", entryBearerField: "wifiBearer", label: "WiFi" },
  // TNB/AIR carry a 4-value *pattern* (tnbPattern/airPattern), not an owner|tenant bearer, so
  // they expose none here. The recurring writer never writes bearer anyway; these fields exist
  // only so the preview can READ the current value for display.
  TNB: { entryAmountField: "tnbTotalRaw", saveBodyField: "tnbTotal", entryNatureField: null, entryBearerField: null, label: "TNB (electricity)" },
  AIR: { entryAmountField: "airSelangorRaw", saveBodyField: "airSelangor", entryNatureField: null, entryBearerField: null, label: "AIR (Air Selangor — water)" },
  // MAINTENANCE is billable as of 69fc262f: it is a PoolComponents field, carries a per-room
  // maintenanceShare, and mints a real Charge via the maintenance_tenant/_owner categories.
  MAINTENANCE: { entryAmountField: "maintenanceFee", saveBodyField: "maintenanceFee", entryNatureField: null, entryBearerField: "maintenanceFeeBearer", label: "Maintenance" },
} as const satisfies Record<
  string,
  { entryAmountField: string; saveBodyField: string; entryNatureField: string | null; entryBearerField: string | null; label: string }
>;

export type ScalarRecurringKind = keyof typeof SCALAR_RECURRING_KINDS;

/** Stable iteration order for every consumer (DTO keys, drawer rows, governance map). */
export const SCALAR_RECURRING_KIND_LIST = Object.keys(SCALAR_RECURRING_KINDS) as ScalarRecurringKind[];

/** The `UnitBillsGridEntry` money column a kind snapshots into. */
export type ScalarEntryAmountField =
  (typeof SCALAR_RECURRING_KINDS)[ScalarRecurringKind]["entryAmountField"];

export function isScalarRecurringKind(kind: string): kind is ScalarRecurringKind {
  return Object.prototype.hasOwnProperty.call(SCALAR_RECURRING_KINDS, kind);
}

/** Per-kind governance flags — `true` when an ENABLED revision covers the period. */
export type ScalarGovernance = Record<ScalarRecurringKind, boolean>;

/** All-false governance; the shared starting point so no consumer hand-builds the shape. */
export function noScalarGovernance(): ScalarGovernance {
  return Object.fromEntries(SCALAR_RECURRING_KIND_LIST.map((k) => [k, false])) as ScalarGovernance;
}
