import { describe, expect, it } from "vitest";
import { toCsv } from "../csv-export";

describe("toCsv", () => {
  it("emits header + rows with RFC 4180 escaping", () => {
    const out = toCsv(
      [
        { name: "Alice", note: 'Has "quotes"' },
        { name: "Bob, Jr.", note: "line1\nline2" },
      ],
      [
        { key: "name", label: "Name" },
        { key: "note", label: "Note" },
      ],
    );
    expect(out).toBe(
      `Name,Note\r\nAlice,"Has ""quotes"""\r\n"Bob, Jr.","line1\nline2"\r\n`,
    );
  });

  it("handles null / undefined as empty", () => {
    const out = toCsv(
      [{ a: null, b: undefined, c: 0 }],
      [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "c", label: "C" },
      ],
    );
    expect(out).toBe(`A,B,C\r\n,,0\r\n`);
  });

  it("emits header only when rows empty", () => {
    const out = toCsv([], [{ key: "a", label: "A" }]);
    expect(out).toBe(`A\r\n`);
  });
});
