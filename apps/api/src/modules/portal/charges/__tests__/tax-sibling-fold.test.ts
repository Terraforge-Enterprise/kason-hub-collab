import { describe, it, expect } from "vitest";
import {
  pickFoldableTaxSiblingIds,
  displayWhere,
  pageSiblingWhere,
  type ChargeLineage,
} from "../tax-sibling-fold";

const row = (id: string, parentChargeId: string | null = null): ChargeLineage => ({ id, parentChargeId });

describe("pickFoldableTaxSiblingIds", () => {
  it("folds a tax sibling whose base is in the same visible set", () => {
    const rows = [row("base"), row("tax", "base")];
    expect(pickFoldableTaxSiblingIds(rows, new Set(["tax"]))).toEqual(["tax"]);
  });

  it("does NOT fold a correction replacement — parentChargeId is generic lineage", () => {
    // `correction-replace.service.ts` points an RPL- charge at the charge it
    // supersedes through this same column. Only an isTax document line marks a tax
    // sibling, so with an empty tax set nothing folds.
    const rows = [row("original"), row("replacement", "original")];
    expect(pickFoldableTaxSiblingIds(rows, new Set())).toEqual([]);
  });

  it("keeps an orphan visible when its base is outside the visible set", () => {
    // Base already settled, so it is not in this list at all.
    const rows = [row("tax", "paidBase")];
    expect(pickFoldableTaxSiblingIds(rows, new Set(["tax"]))).toEqual([]);
  });

  it("keeps a tax charge visible when its parent link was never written", () => {
    expect(pickFoldableTaxSiblingIds([row("base"), row("tax", null)], new Set(["tax"]))).toEqual([]);
  });

  it("refuses to fold a tax charge into another tax charge", () => {
    const rows = [row("taxA", "missing"), row("taxB", "taxA")];
    expect(pickFoldableTaxSiblingIds(rows, new Set(["taxA", "taxB"]))).toEqual([]);
  });

  it("folds several siblings of the same base", () => {
    const rows = [row("base"), row("t1", "base"), row("t2", "base")];
    expect(pickFoldableTaxSiblingIds(rows, new Set(["t1", "t2"]))).toEqual(["t1", "t2"]);
  });

  it("returns nothing for an empty set", () => {
    expect(pickFoldableTaxSiblingIds([], new Set())).toEqual([]);
  });
});

describe("displayWhere", () => {
  const base = { partyId: "p1", organizationId: "o1" };

  it("excludes the foldable siblings so `total` counts display rows", () => {
    expect(displayWhere(base, ["tax"])).toEqual({ ...base, id: { notIn: ["tax"] } });
  });

  it("returns the filter UNTOUCHED when nothing folds", () => {
    // Prisma renders `notIn: []` as a contradiction on some connectors, and this
    // keeps the no-SST path byte-identical to life before folding existed.
    const out = displayWhere(base, []);
    expect(out).toEqual(base);
    expect(out).not.toHaveProperty("id");
  });
});

describe("pageSiblingWhere", () => {
  const base = { partyId: "p1", organizationId: "o1" };

  it("scopes the pull-in to the page's own bases, so a sibling is fetched once", () => {
    expect(pageSiblingWhere(base, ["tax"], ["base"])).toEqual({
      ...base,
      id: { in: ["tax"] },
      parentChargeId: { in: ["base"] },
    });
  });

  it("returns null when there is nothing to pull in", () => {
    expect(pageSiblingWhere(base, [], ["base"])).toBeNull();
    expect(pageSiblingWhere(base, ["tax"], [])).toBeNull();
  });
});
