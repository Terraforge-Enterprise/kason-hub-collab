import { describe, it, expect } from "vitest";
import { distinctCounts, applyMapping, parseMappingCsv } from "../mapping";
import type { RawTenantRow } from "../../types";

const rows = [
  { agentLabel: "KENDRA", roomName: "Master Room" },
  { agentLabel: "Kendra", roomName: "Master Room" },
  { agentLabel: null, roomName: "Studio" },
] as unknown as RawTenantRow[];

describe("distinctCounts", () => {
  it("counts raw agent labels (case-sensitive, RAW)", () => {
    expect(distinctCounts(rows, "agentLabel")).toEqual([
      { value: "KENDRA", count: 1 },
      { value: "Kendra", count: 1 },
    ]);
  });
});

describe("applyMapping", () => {
  it("rewrites raw → canonical when a map is given; passthrough otherwise", () => {
    const map = new Map([["Kendra", "KENDRA"]]);
    expect(applyMapping("Kendra", map)).toBe("KENDRA");
    expect(applyMapping("KENDRA", map)).toBe("KENDRA");
    expect(applyMapping(null, map)).toBeNull();
  });
});

describe("parseMappingCsv", () => {
  it("parses raw,canonical lines into a Map", () => {
    const map = parseMappingCsv("Kendra,KENDRA\nYang,YANG");
    expect(map.get("Kendra")).toBe("KENDRA");
    expect(map.get("Yang")).toBe("YANG");
    expect(map.size).toBe(2);
  });
  it("tolerates a header row and CRLF line endings", () => {
    const map = parseMappingCsv("raw,canonical\r\nKendra,KENDRA\r\n");
    expect(map.has("raw")).toBe(false);
    expect(map.get("Kendra")).toBe("KENDRA");
    expect(map.size).toBe(1);
  });
  it("skips blank lines and rows missing a canonical value", () => {
    const map = parseMappingCsv("\nKendra,KENDRA\nNoCanonical\n  ,  \n");
    expect(map.get("Kendra")).toBe("KENDRA");
    expect(map.has("NoCanonical")).toBe(false);
    expect(map.size).toBe(1);
  });
  it("trims whitespace around values", () => {
    const map = parseMappingCsv("  Kendra  ,  KENDRA  ");
    expect(map.get("Kendra")).toBe("KENDRA");
  });
});
