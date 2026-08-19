/**
 * The DB-row half of the utility drift class — the half TypeScript cannot see.
 *
 * UTILITY_SPEC makes every CODE site exhaustive: add a utility and the classifier, the
 * description map, the supplier map, the category-code list and the resolver either update
 * themselves or fail to compile. None of that reaches the seed ROWS. A utility can be
 * declared, compile everywhere, and still have no ChargeCategory to mint against — and
 * that failure mode is severe: resolveGridInvoiceCategories returns null when ANY required
 * code is missing, which fails EVERY grid Bill closed (69fc262f's own deploy note).
 *
 * Pure unit test, no DB: it compares two constants that must agree.
 */
import { describe, expect, it } from "vitest";
import { SEED_CHARGE_CATEGORIES } from "@kason/shared";
import { GRID_UTILITY_CATEGORY_CODES, UTILITIES, UTILITY_SPEC, ownerCategoryCode, tenantCategoryCode } from "../utility-spec";

describe("UTILITY_SPEC ↔ seeded ChargeCategories", () => {
  const seededCodes = new Set(SEED_CHARGE_CATEGORIES.map((c) => c.code));

  it("every utility has a seeded tenant category", () => {
    const missing = UTILITIES.filter((u) => !seededCodes.has(tenantCategoryCode(u)));
    expect(missing).toEqual([]);
  });

  it("every owner-category utility has a seeded owner category", () => {
    const missing = UTILITIES
      .filter((u) => UTILITY_SPEC[u].ownerCategory)
      .filter((u) => !seededCodes.has(ownerCategoryCode(u)));
    expect(missing).toEqual([]);
  });

  it("a utility WITHOUT an owner category has none seeded either (subsidy is tenant-only)", () => {
    const unexpected = UTILITIES
      .filter((u) => !UTILITY_SPEC[u].ownerCategory)
      .filter((u) => seededCodes.has(ownerCategoryCode(u)));
    expect(unexpected).toEqual([]);
  });

  it("every code the grid must resolve is actually seeded", () => {
    // The exact fail-closed set. A code here with no seed row = every Bill fails.
    const missing = GRID_UTILITY_CATEGORY_CODES.filter((c) => !seededCodes.has(c));
    expect(missing).toEqual([]);
  });

  it("an owner-borne utility is always one that has an owner category", () => {
    // ownerBorneable ⊆ ownerCategory. The converse is fine (sewerage has an owner
    // category but is never owner-borne by the grid), but a utility the grid CAN
    // attribute to the owner with nowhere to book it would throw at mint time.
    const broken = UTILITIES.filter((u) => UTILITY_SPEC[u].ownerBorneable && !UTILITY_SPEC[u].ownerCategory);
    expect(broken).toEqual([]);
  });

  it("only pass-through utilities name an external supplier", () => {
    const wrong = UTILITIES.filter((u) => (UTILITY_SPEC[u].supplier !== null) !== (UTILITY_SPEC[u].bucket === "passthrough"));
    expect(wrong).toEqual([]);
  });
});

describe("SEED_CHARGE_CATEGORIES invariants", () => {
  it("sortOrder is unique — collisions make picker order arbitrary", () => {
    // maintenance_tenant shipped on 65 (subsidy_tenant's) and maintenance_owner on 111
    // (electricity_owner's). Cosmetic, but silent: nothing failed, the lists just ordered
    // themselves arbitrarily. Cheap to assert, so assert it.
    const seen = new Map<number, string[]>();
    for (const c of SEED_CHARGE_CATEGORIES) {
      seen.set(c.sortOrder, [...(seen.get(c.sortOrder) ?? []), c.code]);
    }
    const dupes = [...seen.entries()].filter(([, codes]) => codes.length > 1);
    expect(dupes).toEqual([]);
  });

  it("category codes are unique", () => {
    const codes = SEED_CHARGE_CATEGORIES.map((c) => c.code);
    expect(codes.length).toBe(new Set(codes).size);
  });
});
