// Bearer-driven cell applicability (owner/tenant single-active-side). Split
// out of grid-table.tsx (Task 8) into its own non-component module so
// nav-cells.ts's import doesn't trip react-refresh/only-export-components on
// a component file. Pure move — no logic change; grid-table.tsx and
// nav-cells.ts both import `isApplicable` from here now.
import type { z } from "zod";
import type { utilityPattern } from "@kason/shared";
import type { GridRow } from "@/api/bills-grid";
import type { ColumnId } from "./columns";

/** The four TNB/AIR patterns, sourced from the SHARED zod enum so this module cannot
 *  drift from what the API accepts and the Setting drawer writes. */
type UtilityPattern = z.infer<typeof utilityPattern>;

// ── cell value + applicability (owner/tenant bearer-driven single-active-side) ─

/**
 * The `utilityPattern` values under which the TENANT ultimately bears the cost.
 *
 * ONE reading of the enum, asked by every consumer — column applicability below, the
 * TNB cell's bearer marker (grid-table.tsx) and the xlsx export. Four call sites
 * agreeing by hand-copied literal is exactly how the AIR columns silently drifted away
 * from the Unit setting drawer: `bd80276a` (2026-07-27) narrowed the drawer to write
 * "absorbed" (Owner) / "recharged" (Tenant), described itself as presentation-only, and
 * left this module still splitting AIR on "tenant_direct" — a value the drawer can no
 * longer produce. Both new choices therefore landed on the Owner side and the Tenant
 * column was permanently blank.
 *
 *   recharged        the owner fronts the provider bill, KAEN recharges the tenant
 *   manager_advanced KAEN fronted it and recovers it from the tenant pool (shape.ts
 *                    flows the FULL raw amount into that pool, same as recharged)
 *   tenant_direct    the tenant settles with the provider themselves — tenant-SIDE, but
 *                    never billed through the grid (shape.ts zeroes the pool and the
 *                    mint skips the component). Kept on the tenant side because that is
 *                    where the amount is RECORDED; unbillable-amounts.ts then warns
 *                    before a Bill silently discards it.
 *   absorbed         the owner eats it, nothing reaches the tenant — the only owner one.
 */
const TENANT_BEARS_UTILITY: Record<UtilityPattern, boolean> = {
  absorbed: false,
  recharged: true,
  manager_advanced: true,
  tenant_direct: true,
};

/**
 * True when this TNB/AIR pattern means the tenant bears the cost.
 *
 * `Record<UtilityPattern, …>` keyed off the SHARED zod enum, never a `Set<string>` — a
 * bare set of strings is what let `bd80276a` happen at all. Widen `utilityPattern`
 * (packages/shared/src/schemas/bills-grid.ts) and this table stops compiling until the new
 * value is answered; a set would have swallowed it, defaulted the column to Owner, and
 * blanked the Tenant side exactly as before. Same reasoning as `columns.ts`'s
 * `Record<ColumnId, SettlementBucket | null>`.
 *
 * The `string` parameter is deliberate at the boundary: entries and configs carry a plain
 * DB string, and an UNRECOGNISED one reads as owner-borne — the recoverable direction (an
 * unexpected tenant charge gets spotted and flipped; a silently-absent one is noticed
 * months later), matching `bearerDefaultsFor`'s reasoning on the API side.
 */
export function isUtilityTenantBorne(pattern: string): boolean {
  return TENANT_BEARS_UTILITY[pattern as UtilityPattern] ?? false;
}

/**
 * True when the TENANT settles with the provider directly, so the grid never bills the
 * utility at all — `shapeUtilityPool` zeroes the pool and the mint skips the component
 * (apps/api/.../shape.ts, service.ts).
 *
 * Distinct from {@link isUtilityTenantBorne}, which asks who ultimately BEARS the cost:
 * `tenant_direct` is true for both, `recharged` only for the latter. Named here so the
 * module's "one reading of the enum" claim is actually true — three hand-copied
 * `=== "tenant_direct"` literals used to sit outside it.
 */
export function isProviderPaidByTenant(pattern: string): boolean {
  return pattern === "tenant_direct";
}

/** The five per-line bearer settings, which the entry and the unit config both carry. */
type BearerField = "cleaningBearer" | "wifiBearer" | "maintenanceFeeBearer" | "tnbPattern" | "airPattern";

/**
 * One line setting for this row, ENTRY first.
 *
 * The precedence is the whole contract and it is easy to get backwards: `getOrCreateEntry`
 * snapshots the unit config the first time a month is opened and never re-reads it, so an
 * opened month must report what it will actually BILL, not what the unit's setting says
 * today. `null` entry is the normal never-opened state, where the config IS the answer.
 *
 * Every reader goes through here rather than repeating `row.entry?.x ?? row.bearerConfig.x`
 * — that idiom was already written out nine times across three functions, which is exactly
 * the shape a future edit updates eight of.
 */
function bearerOf(row: GridRow, field: BearerField): string {
  return row.entry?.[field] ?? row.bearerConfig[field];
}

/**
 * True when this column must carry the tenant-borne corner marker.
 *
 * The marker exists for the bands that have a SINGLE money column headed "Owner" and no
 * tenant-side sibling to move the amount into — so unlike Cleaning/WiFi/AIR, a tenant-borne
 * cost there is invisible. Both are deliberate one-column bands:
 *
 *   tnbOwner        the master provider bill; the tenant's share is the per-room meter +
 *                   pax split, a different number, so a "Tenant" column would misstate it.
 *   maintenanceFee  `maintenanceFeeBearer` is LIVE money — computeAllocation pools a
 *                   tenant-borne fee into the per-pax split — and the drawer still shows
 *                   "Borne by the tenant" as a real state even though its bearer CONTROL
 *                   was removed, so existing rows can carry it.
 *
 * Note the two read DIFFERENT vocabularies: TNB carries a `utilityPattern`, maintenance a
 * plain owner|tenant bearer. Keeping that difference in ONE function is the point — it is
 * the thing four scattered call sites would get wrong.
 *
 * Reads the ENTRY snapshot first, exactly like {@link isApplicable}: an opened month must
 * report what it will actually bill, not the unit's since-changed default.
 */
export function showsTenantBorneMark(row: GridRow, columnId: ColumnId): boolean {
  switch (columnId) {
    case "maintenanceFee":
      return bearerOf(row, "maintenanceFeeBearer") === "tenant";
    default:
      return false;
  }
}

/**
 * True when this owner/tenant column is the ACTIVE side for the row's bearer setting — the
 * other side is not applicable, since only one side is billed at a time. Columns with no
 * bearer question (rental, the read-only totals, the meter sub-rows) are always applicable.
 *
 * `entry === null` is the normal pre-Save state (there is no auto-save; the entry is
 * created only on Save) — it is NOT "assume owner". `row.bearerConfig` is ALWAYS present
 * (the server sends defaults when no config row exists), so the active side falls back to
 * it whenever the entry has not snapshotted its own setting yet.
 */
export function isApplicable(row: GridRow, columnId: ColumnId): boolean {
  // Resolved PER CASE rather than all four up front. This runs once per cell per render
  // (grid-table.tsx), once per cell again for keyboard nav (nav-cells.ts), once per cell
  // on export and once per staged edit on Save — so on a large grid the eager version did
  // four lookups where one was wanted and threw three away, every time. Same lazy shape as
  // `showsTenantBorneMark` above, which keeps the two functions reading alike.
  switch (columnId) {
    case "cleaningOwner":
      return bearerOf(row, "cleaningBearer") !== "tenant";
    case "cleaningTenant":
      return bearerOf(row, "cleaningBearer") === "tenant";
    // AIR owns BOTH a tenant and an owner column, so its bearer setting picks the side —
    // the same switch cleaningOwner/cleaningTenant already are. Exactly one is applicable
    // for every pattern value (pinned by an invariant test), so the pair can never render
    // the amount twice or nowhere.
    case "airOwner":
      return !isUtilityTenantBorne(bearerOf(row, "airPattern"));
    case "airTenant":
      return isUtilityTenantBorne(bearerOf(row, "airPattern"));
    // tenant_direct silent-drop fix (2026-07-27): TNB had NO case here, so `default: true` left
    // the TNB cells fully editable under "Tenant pays directly" — while shapeUtilityPool
    // (apps/api/.../shape.ts) forces the whole TNB pool to 0 and the mint skips the component
    // outright (service.ts, `fundedBy === "tenant_direct"`). A typed RM 500 was therefore saved
    // and then discarded at Bill with no signal anywhere. The grid's own wire map already
    // assumed this could not happen ("TNB is never tenant-direct"), but the Unit setting drawer
    // offers the option, so the assumption was false. Mark the cells inapplicable instead —
    // the same treatment airOwner already had.
    //
    // TNB has NO tenant-side column and is not getting one (client decision 2026-08-14):
    // the figure typed here is the master provider bill, while the tenant's share is the
    // per-room meter + pax split — a different number, so a "Tenant" header over it would
    // state something false. The bearer is surfaced on this cell by the corner marker
    // instead (`tenantBorneMark` in grid-table.tsx), which reads the SAME
    // `isUtilityTenantBorne` predicate as the AIR split above.
    case "tnbOwner":
      return bearerOf(row, "tnbPattern") === "absorbed";
    case "tnbTenant": {
      const pattern = bearerOf(row, "tnbPattern");
      return isUtilityTenantBorne(pattern) && !isProviderPaidByTenant(pattern);
    }
    // The per-room meter sub-rows are deliberately LEFT APPLICABLE. Their aircond amounts are
    // also unbillable under tenant_direct (the electricity component is skipped wholesale), but
    // a meter reading is a physical record with value independent of billing — blocking its
    // entry would remove a record-keeping flow nobody asked to lose. The Bill-time warning
    // covers that case instead of the cell being disabled.
    case "wifiOwner":
      return bearerOf(row, "wifiBearer") !== "tenant";
    case "wifiTenant":
      return bearerOf(row, "wifiBearer") === "tenant";
    default:
      return true;
  }
}
