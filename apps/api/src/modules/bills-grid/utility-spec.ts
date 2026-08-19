/**
 * THE single declaration of what a grid utility is.
 *
 * WHY THIS FILE EXISTS. Adding `maintenance` to the utility set (69fc262f) required
 * coordinated edits in roughly a dozen places that each independently restated the same
 * set — bucket arrays, a description map, a supplier map, a category-code array, an
 * `OwnerUtility` union, a category-map type, and the resolver body. Five were missed, and
 * each miss surfaced separately and expensively:
 *
 *   7d95e446  missing from the tenant component list  -> IssuanceError("SUM_INVARIANT")
 *   bc2732cc  four array literals -> exhaustive Records (reactive, after the fact)
 *   bd3f6047  missing from the classifier's buckets   -> every Bill with a maintenance
 *             fee failed, reported to the admin as "couldn't issue the invoice"
 *
 * TypeScript checks each element of a `Utility[]` literal against `Utility`, but never
 * that every member APPEARS — so an omission compiles clean and detonates at Bill time,
 * inside the row transaction, behind a generic error message.
 *
 * So: declare each utility ONCE, with the facts every consumer needs, and let the
 * consumers derive. Adding a utility is now one entry here; every derived site either
 * updates itself or fails to compile.
 *
 * WHAT IS DELIBERATELY *NOT* DERIVED FROM HERE:
 *   • TENANT_SHARE_OF / OWNER_AMOUNT_OF (service.ts) keep their own literals. They are
 *     already exhaustive `Record`s — so membership is enforced — and their KEY ORDER is
 *     load-bearing: it sets invoice line order via Object.keys. The two orders genuinely
 *     differ (owner lists cleaning before wifi; this file lists wifi before cleaning), so
 *     deriving either from this file would silently reorder real invoice lines.
 *   • The seed rows in seed-categories.ts. They carry ledgerCategory / isSystem /
 *     sortOrder that have nothing to do with utility semantics; generating them would
 *     churn a money-seed file to save four lines. `utility-spec.test.ts` asserts the two
 *     stay in agreement instead — the DB-row half of the drift class that types can't see.
 */

export type UtilityBucket = "passthrough" | "service" | "subsidy";

type UtilitySpecShape = {
  /** Economic treatment — see classifyUtilityCharge. */
  readonly bucket: UtilityBucket;
  /** Charge description stem; the mint appends the YYYYMM. */
  readonly description: string;
  /** External provider, or null for an internal KAEN service / owner offset. */
  readonly supplier: string | null;
  /** Can the GRID attribute this component to the owner? Drives OwnerUtility.
   *  NOTE sewerage is `false` while its owner CATEGORY exists — the category is seeded
   *  and resolved, but no grid path ever mints an owner-borne sewerage charge. */
  readonly ownerBorneable: boolean;
  /** Does a `<utility>_owner` ChargeCategory exist? False only for subsidy, which is an
   *  owner-funded offset shown on the TENANT invoice and has no owner counterpart. */
  readonly ownerCategory: boolean;
};

/** Key order here matches TENANT_SHARE_OF's, which is the tenant invoice's line order. */
export const UTILITY_SPEC = {
  electricity: { bucket: "passthrough", description: "Electricity (TNB)", supplier: "TNB", ownerBorneable: true, ownerCategory: true },
  water: { bucket: "passthrough", description: "Water (Air Selangor)", supplier: "Air Selangor", ownerBorneable: true, ownerCategory: true },
  sewerage: { bucket: "passthrough", description: "Sewerage (Indah Water)", supplier: "Indah Water", ownerBorneable: false, ownerCategory: true },
  wifi: { bucket: "service", description: "WiFi", supplier: null, ownerBorneable: true, ownerCategory: true },
  cleaning: { bucket: "service", description: "Cleaning", supplier: null, ownerBorneable: true, ownerCategory: true },
  maintenance: { bucket: "service", description: "Maintenance", supplier: null, ownerBorneable: true, ownerCategory: true },
  subsidy: { bucket: "subsidy", description: "Subsidy", supplier: null, ownerBorneable: false, ownerCategory: false },
} as const satisfies Record<string, UtilitySpecShape>;

export type Utility = keyof typeof UTILITY_SPEC;

/** The subset the grid can attribute to the owner — derived, never restated. */
export type OwnerUtility = {
  [K in Utility]: (typeof UTILITY_SPEC)[K]["ownerBorneable"] extends true ? K : never;
}[Utility];

export const UTILITIES = Object.keys(UTILITY_SPEC) as Utility[];

export const UTILITY_DESCRIPTION = Object.fromEntries(
  UTILITIES.map((u) => [u, UTILITY_SPEC[u].description]),
) as Record<Utility, string>;

/** Only pass-through utilities have an external provider; wifi/cleaning/maintenance/
 *  subsidy are internal (KAEN service or owner offset) — no sourceSupplier. */
export const UTILITY_SUPPLIER = Object.fromEntries(
  UTILITIES.filter((u) => UTILITY_SPEC[u].supplier !== null).map((u) => [u, UTILITY_SPEC[u].supplier]),
) as Partial<Record<Utility, string>>;

export const tenantCategoryCode = (u: Utility) => `${u}_tenant`;
export const ownerCategoryCode = (u: Utility) => `${u}_owner`;

/** Every ChargeCategory code the grid must be able to resolve. A code missing from the
 *  DB makes resolveGridInvoiceCategories return null, which fails EVERY grid Bill closed
 *  — so this list drifting is not a cosmetic bug. */
export const GRID_UTILITY_CATEGORY_CODES: readonly string[] = UTILITIES.flatMap((u) =>
  UTILITY_SPEC[u].ownerCategory ? [tenantCategoryCode(u), ownerCategoryCode(u)] : [tenantCategoryCode(u)],
);
