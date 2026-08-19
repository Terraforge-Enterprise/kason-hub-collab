// Per-listing-mode DEFAULTS for a unit that has NEVER been configured.
//
// These are DEFAULTS, not rules. Every one of them stays editable per unit in the
// Setting drawer (manager-only, set-once + audited unlock). Nothing here forces a
// bearer onto a unit; it only decides the value a unit STARTS with, before an admin
// has said anything.
//
// Why per listing mode: a WHOLE unit is one tenant who takes the whole package, so
// cleaning and WiFi are theirs. A PARTITIONED unit's cleaning and WiFi are shared
// common-area costs the owner carries as part of running the rooms. Before this, one
// set of Prisma column defaults served both, so every partition unit and every whole
// unit started identical (cleaning/WiFi owner-borne) — and a whole unit's tenant was
// silently never billed for either unless an admin remembered to flip them.
//
// TNB / AIR default to "recharged" (= Tenant) in BOTH modes. The partitioned
// excess→owner behaviour is NOT expressed here: it is engine-side, driven off
// `listingMode` via computeAllocation's `privateAircond` flag (meter/compute.ts:113),
// where Σ per-room aircond above the master TNB bill clamps the tenant pool at 0 and
// leaves the spread with the owner. Setting TNB to "absorbed" here would instead mean
// "the owner eats the whole bill and no tenant is charged" — a different thing.
//
// Applies ONLY where no `UnitBillsBearerConfig` row exists yet. A unit an admin has
// already saved keeps exactly what they chose; nothing here is retroactive and no
// already-open or billed month is rewritten.
import type { ListingMode } from "@prisma/client";

/** The bearer fields a unit-type default decides. Mirrors the writable columns of
 *  `UnitBillsBearerConfig` (minus `cleaningRecurringAmount`, which is an amount, not a
 *  bearer, and minus the natures, which stay deliberately undecided — see the
 *  charge-nature gate). */
export type UnitBearerDefaults = {
  tnbPattern: string;
  airPattern: string;
  cleaningBearer: string;
  wifiBearer: string;
  maintenanceFeeBearer: string;
};

/**
 * `Record<ListingMode, …>` on purpose, never a lookup with a fallback branch: adding a
 * member to the `ListingMode` enum must be a TYPE ERROR here, not a silent fallthrough
 * to whichever mode happened to be the default. A missed mode is money — it decides
 * whether a tenant is billed for cleaning and WiFi.
 */
export const BEARER_DEFAULTS_BY_LISTING_MODE: Record<ListingMode, UnitBearerDefaults> = {
  WHOLE: {
    tnbPattern: "recharged", // Tenant
    airPattern: "recharged", // Tenant
    cleaningBearer: "tenant",
    wifiBearer: "tenant",
    maintenanceFeeBearer: "owner", // unchanged — the drawer control is read-only today
  },
  PARTITIONED: {
    tnbPattern: "recharged", // Tenant — the excess→owner spread is engine-side, see above
    airPattern: "recharged", // Tenant
    cleaningBearer: "owner", // shared common-area cost
    wifiBearer: "owner", // shared common-area cost
    maintenanceFeeBearer: "owner",
  },
};

/**
 * The recurring-cleaning amount a never-configured unit STARTS with, as a 2dp money
 * string. `"0.00"` means "no recurring cleaning until an admin sets one" — 0 is the
 * established disabled sentinel on this field (see `backfill-recurring-defs.ts`, which
 * reads `0/null ⇒ disabled`).
 *
 * ⚠️ It was `"100.00"` until 2026-08-17, in THREE places that had to agree by hand: the
 * Prisma column default, `toBearerConfigDto`'s no-config branch, and
 * `getBearerConfigService`'s no-config branch. A unit nobody had configured therefore
 * showed RM 100 in the grid's cleaning cell, and — worse than cosmetic —
 * `getOrCreateEntry` (repository.ts) FREEZES that seed onto the month's entry, so the
 * phantom 100 became a real billable amount. The bills grid already owns cleaning: the
 * unit setting drawer sets the bearer and the Recurring editor sets the amount, so a
 * hardcoded starting amount only ever conflicted with them.
 *
 * ⚠️ Must stay in lock-step with `UnitBillsBearerConfig.cleaningRecurringAmount`'s
 * `@default` in schema.prisma — that default is what a row created by
 * `resolveBearerConfig` actually gets; this constant only covers the read paths where
 * no row exists yet. If the two disagree, the drawer shows one number and the entry
 * bills another.
 */
export const DEFAULT_CLEANING_RECURRING_AMOUNT = "0.00";

/**
 * Defaults for one apartment's listing mode.
 *
 * `listingMode` is NON-NULL in the schema, so the nullable input is defensive only —
 * it covers a caller that could not resolve the apartment at all. That case falls back
 * to WHOLE deliberately: a unit whose mode is unknown is far more likely to be a plain
 * whole unit, and WHOLE's tenant-borne cleaning/WiFi is the recoverable direction (an
 * admin sees an unexpected tenant charge and flips it) rather than the silent one
 * (nobody is billed and it is noticed months later).
 */
export function bearerDefaultsFor(listingMode: ListingMode | string | null | undefined): UnitBearerDefaults {
  return listingMode === "PARTITIONED"
    ? BEARER_DEFAULTS_BY_LISTING_MODE.PARTITIONED
    : BEARER_DEFAULTS_BY_LISTING_MODE.WHOLE;
}
