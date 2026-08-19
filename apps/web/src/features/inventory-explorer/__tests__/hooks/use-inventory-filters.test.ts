import { describe, it, expect } from "vitest";
import { parseFilters, serializeFilters } from "../../hooks/use-inventory-filters";
import { EMPTY_FILTERS as EMPTY, type InventoryFilters } from "../../domain/types";

describe("parseFilters URL migration", () => {
  it("legacy ?ready=1 alone maps to availability=now", () => {
    const f = parseFilters(new URLSearchParams("ready=1"));
    expect(f.availability).toBe("now");
    expect((f as any).ready).toBeUndefined();
  });

  it("legacy ?occupied=1 alone maps to availability=all", () => {
    const f = parseFilters(new URLSearchParams("occupied=1"));
    expect(f.availability).toBe("all");
  });

  it("legacy ?ready=1&occupied=1 (both set) maps to availability=all", () => {
    const f = parseFilters(new URLSearchParams("ready=1&occupied=1"));
    expect(f.availability).toBe("all");
  });

  it("no availability param defaults to 'all'", () => {
    const f = parseFilters(new URLSearchParams(""));
    expect(f.availability).toBe("all");
  });

  it("explicit ?availability=occupied wins over legacy params", () => {
    const f = parseFilters(new URLSearchParams("availability=occupied&ready=1"));
    expect(f.availability).toBe("occupied");
  });
});

describe("parseFilters new filter URL keys", () => {
  it("parses sourcedBy as comma-separated party IDs", () => {
    const f = parseFilters(new URLSearchParams("sourcedBy=p1,p2"));
    expect(f.sourcedByPartyIds).toEqual(["p1", "p2"]);
  });

  it("parses furnishing values", () => {
    const f = parseFilters(new URLSearchParams("furnishing=Fully,Partially"));
    expect(f.furnishingLevels).toEqual(["Fully", "Partially"]);
  });

  it("parses amenities values", () => {
    const f = parseFilters(new URLSearchParams("amenities=Pool,Gym"));
    expect(f.amenities).toEqual(["Pool", "Gym"]);
  });

  it("parses floorMin/floorMax as ints; ignores garbage", () => {
    const f = parseFilters(new URLSearchParams("floorMin=1&floorMax=10"));
    expect(f.floorMin).toBe(1);
    expect(f.floorMax).toBe(10);
    const g = parseFilters(new URLSearchParams("floorMin=garbage&floorMax="));
    expect(g.floorMin).toBeNull();
    expect(g.floorMax).toBeNull();
  });

  it("parses facings normalized to uppercase, drops invalid", () => {
    const f = parseFilters(new URLSearchParams("facing=N,south,E,garbage,123"));
    expect(f.facings).toEqual(["N", "S", "E"]);
  });

  it("parses vacantSinceMinDays as int", () => {
    const f = parseFilters(new URLSearchParams("vacantMin=60"));
    expect(f.vacantSinceMinDays).toBe(60);
  });

  it("parses depositMonthsMax as int", () => {
    expect(parseFilters(new URLSearchParams("deposit=1")).depositMonthsMax).toBe(1);
    expect(parseFilters(new URLSearchParams("deposit=garbage")).depositMonthsMax).toBeNull();
    // "negotiable" was removed as a filter option (no canonical data source).
    expect(parseFilters(new URLSearchParams("deposit=negotiable")).depositMonthsMax).toBeNull();
  });
});

describe("serializeFilters round-trip", () => {
  it("availability=all is omitted from URL (default)", () => {
    const sp = serializeFilters({ ...EMPTY, availability: "all" });
    expect(sp.has("availability")).toBe(false);
  });

  it("availability=now is serialized", () => {
    const sp = serializeFilters({ ...EMPTY, availability: "now" });
    expect(sp.get("availability")).toBe("now");
  });

  it("legacy ready/occupied keys are never written", () => {
    const sp = serializeFilters({ ...EMPTY, availability: "now" });
    expect(sp.has("ready")).toBe(false);
    expect(sp.has("occupied")).toBe(false);
  });

  it("sourcedBy serializes when non-empty, omitted when empty", () => {
    expect(serializeFilters({ ...EMPTY, sourcedByPartyIds: ["p1"] }).get("sourcedBy")).toBe("p1");
    expect(serializeFilters({ ...EMPTY, sourcedByPartyIds: [] }).has("sourcedBy")).toBe(false);
  });

  it("full round-trip: parse(serialize(f)) === f for non-trivial state", () => {
    const f: InventoryFilters = {
      ...EMPTY,
      availability: "now",
      beds: [2, 3],
      facings: ["N", "E"],
      floorMin: 1,
      floorMax: 10,
      depositMonthsMax: 2,
      sourcedByPartyIds: ["p1", "p2"],
      vacantSinceMinDays: 30,
      sources: ["company"],
    };
    expect(parseFilters(serializeFilters(f))).toEqual(f);
  });
});
