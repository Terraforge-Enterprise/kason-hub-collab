import { describe, it, expect } from "vitest";
import { classifyOrphans } from "./classify";

describe("classifyOrphans", () => {
  it("reports a bucket-only key as an orphan", () => {
    const result = classifyOrphans(["a", "orphan"], ["a"]);
    expect(result.orphans).toEqual(["orphan"]);
    expect(result.danglingRefs).toEqual([]);
  });

  it("reports a reference-only key as a dangling ref", () => {
    const result = classifyOrphans(["a"], ["a", "missing"]);
    expect(result.orphans).toEqual([]);
    expect(result.danglingRefs).toEqual(["missing"]);
  });

  it("a key present in both is in neither list", () => {
    const result = classifyOrphans(["a", "b"], ["a", "b"]);
    expect(result.orphans).toEqual([]);
    expect(result.danglingRefs).toEqual([]);
  });

  it("reports orphans and dangling refs together", () => {
    const result = classifyOrphans(["shared", "orphan"], ["shared", "missing"]);
    expect(result.orphans).toEqual(["orphan"]);
    expect(result.danglingRefs).toEqual(["missing"]);
  });

  it("returns empty lists for empty inputs", () => {
    const result = classifyOrphans([], []);
    expect(result.orphans).toEqual([]);
    expect(result.danglingRefs).toEqual([]);
  });

  it("dedupes: a duplicated bucket-only key appears once in orphans", () => {
    const result = classifyOrphans(["orphan", "orphan", "shared"], ["shared"]);
    expect(result.orphans).toEqual(["orphan"]);
  });

  it("dedupes: a duplicated reference-only key appears once in danglingRefs", () => {
    const result = classifyOrphans(["shared"], ["missing", "missing", "shared"]);
    expect(result.danglingRefs).toEqual(["missing"]);
  });

  it("accepts Set inputs as well as arrays", () => {
    const result = classifyOrphans(
      new Set(["a", "orphan"]),
      new Set(["a", "missing"]),
    );
    expect(result.orphans).toEqual(["orphan"]);
    expect(result.danglingRefs).toEqual(["missing"]);
  });
});
